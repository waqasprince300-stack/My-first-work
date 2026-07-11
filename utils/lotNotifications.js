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
async function notifyLotRejected({ lot, note, ownerId }) {
  try {
    const oid = String(ownerId || '').trim();
    if (!oid || !lot) return;

    const partyId = String(lot.partyId || '').trim();
    const partyName = String(lot.partyName || '').trim();
    if (!partyId && !partyName) return;

    const or = [];
    if (partyId) or.push({ partyId });
    if (partyName) {
      or.push({ partyName: new RegExp(`^${partyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    }

    const partyUsers = await User.find({
      role: 'party',
      status: 'approved',
      $or: [{ ownerId: oid }, { approvedBy: oid }],
      $and: [{ $or: or }],
    })
      .select('name email partyId partyName')
      .lean();

    if (!partyUsers.length) return;

    const label = lotLabel(lot);
    const lotId = String(lot._id || lot.id || '').trim();
    const linkPath = `/party-ledger?lotId=${encodeURIComponent(lotId)}`;
    const title = `Lot rejected — ${label}`;
    const body = note
      ? `Admin rejected lot ${label}. Reason: ${note}`
      : `Admin rejected lot ${label}. Open Party Ledger to review and resubmit.`;

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

module.exports = {
  notifyLotRejected,
  notifyLotPendingReview,
  frontendBaseUrl,
};
