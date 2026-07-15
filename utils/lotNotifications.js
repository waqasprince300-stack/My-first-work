const User = require('../models/User');
const Notification = require('../models/Notification');
const { getMailConfigError, sendLotNotificationEmail } = require('./email');

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

const frontendBaseUrl = () => {
  const raw =
    process.env.FRONTEND_URL ||
    process.env.CORS_ORIGIN ||
    'http://localhost:3000';
  const first = String(raw).split(',')[0].trim();
  return first.replace(/\/$/, '') || 'http://localhost:3000';
};

const lotLabel = (lot) => {
  const no = String(lot?.lotNumber || lot?.lotNo || '').trim();
  const design = String(lot?.designNo || '').trim();
  if (no && design) return `${no} / ${design}`;
  return no || design || 'lot';
};

/**
 * Create an unread notification (dedupe same type+lot+user within a short window).
 * Email is best-effort and never throws to the caller.
 */
async function createAndEmailNotification({
  user,
  ownerId,
  type,
  title,
  body,
  lot,
  linkPath,
}) {
  if (!user?._id) return null;

  const lotId = String(lot?._id || lot?.id || '').trim();
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const existing = await Notification.findOne({
    userId: user._id,
    type,
    lotId,
    readAt: null,
    createdAt: { $gte: since },
  }).lean();

  if (existing) {
    return existing;
  }

  const doc = await Notification.create({
    userId: user._id,
    ownerId,
    type,
    title,
    body,
    lotId,
    lotNumber: String(lot?.lotNumber || lot?.lotNo || '').trim(),
    businessOwnerId: String(lot?.businessOwnerId || '').trim(),
    linkPath,
  });

  const email = String(user.email || '').trim();
  if (email && !getMailConfigError()) {
    try {
      await sendLotNotificationEmail({
        to: email,
        name: user.name,
        subject: title,
        body,
        actionUrl: `${frontendBaseUrl()}${linkPath.startsWith('/') ? linkPath : `/${linkPath}`}`,
      });
      doc.emailSentAt = new Date();
      await doc.save();
    } catch (err) {
      console.warn('[lotNotifications] email failed:', err?.message || err);
    }
  }

  return doc.toObject ? doc.toObject() : doc;
}

/** Admin rejected a completion — notify the party user assigned to this lot. */
async function findPartyUsersForLot({ lot, ownerId }) {
  return findPartyUsersByRef({
    ownerId,
    partyId: lot?.partyId,
    partyName: lot?.partyName,
  });
}

async function findPartyUsersByRef({ ownerId, partyId, partyName }) {
  const oid = String(ownerId || '').trim();
  if (!oid) return [];

  const pid = String(partyId || '').trim();
  const pname = String(partyName || '').trim();
  if (!pid && !pname) return [];
  if (pname.toLowerCase() === 'owner') return [];

  const or = [];
  if (pid) or.push({ partyId: pid });
  if (pname) {
    or.push({ partyName: new RegExp(`^${pname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  }

  return User.find({
    role: 'party',
    status: 'approved',
    $or: [{ ownerId: oid }, { approvedBy: oid }],
    $and: [{ $or: or }],
  })
    .select('name email partyId partyName')
    .lean();
}

async function notifyLotRejected({ lot, note, ownerId }) {
  try {
    const oid = String(ownerId || '').trim();
    const partyUsers = await findPartyUsersForLot({ lot, ownerId: oid });
    if (!partyUsers.length) return;

    const label = lotLabel(lot);
    const lotId = String(lot._id || lot.id || '').trim();
    const linkPath = `/party-ledger?lotId=${encodeURIComponent(lotId)}`;
    const title = `Lot rejected — ${label}`;
    const body = note
      ? `The business rejected lot ${label}. Reason: ${note}`
      : `The business rejected lot ${label}. Open My Lots to review and resubmit.`;

    await Promise.all(
      partyUsers.map((user) =>
        createAndEmailNotification({
          user,
          ownerId: oid,
          type: 'lot_rejected',
          title,
          body,
          lot,
          linkPath,
        }),
      ),
    );
  } catch (err) {
    console.warn('[lotNotifications] notifyLotRejected failed:', err?.message || err);
  }
}

/** Party submitted for review — notify org admin users. */
async function notifyLotPendingReview({ lot, ownerId }) {
  try {
    const oid = String(ownerId || '').trim();
    if (!oid || !lot) return;

    const admins = await User.find({
      role: 'admin',
      status: 'approved',
      $or: [{ _id: oid }, { ownerId: oid }],
    })
      .select('name email')
      .lean();

    // Primary org admin is usually _id === ownerId; also include any linked admins.
    const byId = new Map();
    for (const a of admins) byId.set(String(a._id), a);
    if (!byId.has(oid)) {
      const primary = await User.findOne({ _id: oid, role: 'admin', status: 'approved' })
        .select('name email')
        .lean();
      if (primary) byId.set(oid, primary);
    }

    const recipients = [...byId.values()];
    if (!recipients.length) return;

    const label = lotLabel(lot);
    const party = String(lot.partyName || '').trim() || 'Party';
    const lotId = String(lot._id || lot.id || '').trim();
    const linkPath = `/review-lots?lotId=${encodeURIComponent(lotId)}`;
    const title = `Lot awaiting review — ${label}`;
    const body = `${party} submitted lot ${label} for completion approval. Open Review Lots to approve or reject.`;

    await Promise.all(
      recipients.map((user) =>
        createAndEmailNotification({
          user,
          ownerId: oid,
          type: 'lot_pending_review',
          title,
          body,
          lot,
          linkPath,
        }),
      ),
    );
  } catch (err) {
    console.warn('[lotNotifications] notifyLotPendingReview failed:', err?.message || err);
  }
}

async function findOrgAdmins(ownerId) {
  const oid = String(ownerId || '').trim();
  if (!oid) return [];

  const admins = await User.find({
    role: 'admin',
    status: 'approved',
    $or: [{ _id: oid }, { ownerId: oid }],
  })
    .select('name email')
    .lean();

  const byId = new Map();
  for (const a of admins) byId.set(String(a._id), a);
  if (!byId.has(oid)) {
    const primary = await User.findOne({ _id: oid, role: 'admin', status: 'approved' })
      .select('name email')
      .lean();
    if (primary) byId.set(oid, primary);
  }
  return [...byId.values()];
}

/** Party requested a bill-amount change on a completed lot — notify org admins. */
async function notifyBillRevisionRequest({ lot, ownerId, fromAmount, toAmount, reason }) {
  try {
    const oid = String(ownerId || '').trim();
    if (!oid || !lot) return;

    const recipients = await findOrgAdmins(oid);
    if (!recipients.length) return;

    const label = lotLabel(lot);
    const party = String(lot.partyName || '').trim() || 'Party';
    const lotId = String(lot._id || lot.id || '').trim();
    const linkPath = `/party-ledger?lotId=${encodeURIComponent(lotId)}&billReview=1`;
    const from = Number(fromAmount) || 0;
    const to = Number(toAmount) || 0;
    const title = `Bill change request — ${label}`;
    const reasonBit = reason ? ` Reason: ${reason}` : '';
    const body = `${party} requested ₨${from.toLocaleString()} → ₨${to.toLocaleString()} on lot ${label}.${reasonBit} Open Party Ledger to review.`;

    await Promise.all(
      recipients.map((user) =>
        createAndEmailNotification({
          user,
          ownerId: oid,
          type: 'bill_revision_request',
          title,
          body,
          lot,
          linkPath,
        }),
      ),
    );
  } catch (err) {
    console.warn('[lotNotifications] notifyBillRevisionRequest failed:', err?.message || err);
  }
}

/** Admin approved/rejected a bill-change request — notify the party. */
async function notifyBillRevisionResolved({ lot, ownerId, approved, fromAmount, toAmount, note }) {
  try {
    const oid = String(ownerId || '').trim();
    const partyUsers = await findPartyUsersForLot({ lot, ownerId: oid });
    if (!partyUsers.length) return;

    const label = lotLabel(lot);
    const lotId = String(lot._id || lot.id || '').trim();
    const linkPath = `/party-ledger?lotId=${encodeURIComponent(lotId)}`;
    const from = Number(fromAmount) || 0;
    const to = Number(toAmount) || 0;
    const type = approved ? 'bill_revision_approved' : 'bill_revision_rejected';
    const title = approved
      ? `Bill change approved — ${label}`
      : `Bill change rejected — ${label}`;
    const body = approved
      ? `The business approved ₨${from.toLocaleString()} → ₨${to.toLocaleString()} on lot ${label}.`
      : `The business rejected your bill change on lot ${label}.${note ? ` Reason: ${note}` : ''} Open My Lots to review.`;

    await Promise.all(
      partyUsers.map((user) =>
        createAndEmailNotification({
          user,
          ownerId: oid,
          type,
          title,
          body,
          lot,
          linkPath,
        }),
      ),
    );
  } catch (err) {
    console.warn('[lotNotifications] notifyBillRevisionResolved failed:', err?.message || err);
  }
}

/** Admin saved a payment for a party — notify that party's users. */
async function notifyPaymentRecorded({ payment, ownerId }) {
  try {
    const oid = String(ownerId || '').trim();
    if (!oid || !payment) return;

    const partyName = String(payment.party || '').trim();
    const partyId = String(payment.partyId || '').trim();
    if (!partyId && (!partyName || partyName.toLowerCase() === 'owner')) return;

    const partyUsers = await findPartyUsersByRef({
      ownerId: oid,
      partyId,
      partyName,
    });
    if (!partyUsers.length) return;

    const amount = Number(payment.amount) || 0;
    const payType = String(payment.type || '').trim();
    const note = String(payment.note || '').trim();
    const lotBit = String(payment.linkedLot || '').trim();
    const linkPath = '/payments';
    const amt = `₨${amount.toLocaleString()}`;

    // Paid = admin paid the party; Received = party paid the business.
    const title =
      payType === 'Paid'
        ? `Payment to you — ${amt}`
        : `Payment from you — ${amt}`;
    const parts = [];
    if (payType === 'Paid') {
      parts.push(`The business recorded a payment of ${amt} to you.`);
    } else {
      parts.push(`The business recorded a payment of ${amt} from you.`);
    }
    if (lotBit) parts.push(`Lot: ${lotBit}.`);
    if (note) parts.push(`Note: ${note}`);
    parts.push('Open My Payments to review.');

    const paymentId = String(payment._id || payment.id || '').trim();
    await Promise.all(
      partyUsers.map((user) =>
        createAndEmailNotification({
          user,
          ownerId: oid,
          type: 'payment_recorded',
          title,
          body: parts.join(' '),
          // Use payment id as lotId key so rapid successive payments are not deduped away.
          lot: {
            id: paymentId ? `payment:${paymentId}` : '',
            lotNumber: lotBit,
            businessOwnerId: payment.businessOwnerId,
          },
          linkPath,
        }),
      ),
    );
  } catch (err) {
    console.warn('[lotNotifications] notifyPaymentRecorded failed:', err?.message || err);
  }
}

module.exports = {
  notifyLotRejected,
  notifyLotPendingReview,
  notifyBillRevisionRequest,
  notifyBillRevisionResolved,
  notifyPaymentRecorded,
  frontendBaseUrl,
};
