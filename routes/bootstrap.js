const express = require('express');
const router = express.Router();
const BusinessOwner = require('../models/BusinessOwner');
const Party = require('../models/Party');
const GhausiaLot = require('../models/GhausiaLot');
const Payment = require('../models/Payment');
const PartyEdit = require('../models/PartyEdit');
const {
  getDataOwnerId,
  getOwnerFilter,
  getScopedFilter,
  getPartyAllBusinessLotsFilter,
  getPartyPaymentOrConditions,
  getBusinessOwnerFilter,
  isParty,
  isTenantAdmin,
} = require('../utils/access');

const mapPayment = (doc) => ({ ...doc, id: String(doc._id) });
const mapOwner = (doc) => ({ ...doc, id: String(doc._id) });
const mapPartyEdit = (doc) => ({ ...doc, id: String(doc._id) });

const ghausiaLotsFilter = (req, { scopeAll, partyScopeAll }) => {
  if (partyScopeAll && isParty(req.user)) {
    return getPartyAllBusinessLotsFilter(req.user);
  }
  if (scopeAll && isTenantAdmin(req.user)) {
    return { userId: getDataOwnerId(req.user) };
  }
  return getScopedFilter(req);
};

const paymentsFilter = (req, { scopeAll, partyScopeAll }) => {
  if (isParty(req.user)) {
    const partyMatch = partyScopeAll
      ? getPartyPaymentOrConditions(req.user)
      : [
          { partyId: String(req.user.partyId || '') },
          { party: req.user.partyName || '' },
        ];
    return {
      ...getOwnerFilter(req),
      ...(partyScopeAll ? {} : getBusinessOwnerFilter(req)),
      $or: partyMatch,
    };
  }
  if (scopeAll && isTenantAdmin(req.user)) {
    return { ...getOwnerFilter(req) };
  }
  return { ...getOwnerFilter(req), ...getBusinessOwnerFilter(req) };
};

async function partyAllowedLotIds(req, partyScopeAll) {
  if (!isParty(req.user)) return null;
  if (partyScopeAll) {
    const lots = await GhausiaLot.find(getPartyAllBusinessLotsFilter(req.user))
      .select('_id')
      .lean();
    return lots.map((lot) => String(lot._id));
  }
  const lots = await GhausiaLot.find({
    userId: getDataOwnerId(req.user),
    partyId: String(req.user.partyId || ''),
  })
    .select('_id')
    .lean();
  return lots.map((lot) => String(lot._id));
}

async function fetchPartyEdits(req, { scopeAll, partyScopeAll }, receiptSelect, precomputedLotIds) {
  const partyLedgerAll = partyScopeAll && isParty(req.user);
  let allowedLotIds = null;
  if (precomputedLotIds !== undefined) {
    allowedLotIds = precomputedLotIds;
  } else if (partyLedgerAll || isParty(req.user)) {
    allowedLotIds = await partyAllowedLotIds(req, partyScopeAll);
  }

  const allWorkspaces = scopeAll && isTenantAdmin(req.user);
  const bizFilter = allWorkspaces || partyLedgerAll ? {} : getBusinessOwnerFilter(req);
  const filter = {
    ...getOwnerFilter(req),
    ...bizFilter,
    ...(allowedLotIds !== null ? { lotId: { $in: allowedLotIds } } : {}),
  };

  let query = PartyEdit.find(filter).sort({ createdAt: -1 });
  if (receiptSelect) query = query.select(receiptSelect);
  const rows = await query.lean();

  // When base64 receipts are excluded, still tell the client WHICH lots have a bill so the
  // UI can show the thumbnail placeholder and lazy-load the image only for those rows.
  if (receiptSelect) {
    const withReceipt = await PartyEdit.find({
      ...filter,
      receipt: { $exists: true, $nin: ['', null] },
    })
      .select('_id')
      .lean();
    const receiptIds = new Set(withReceipt.map((d) => String(d._id)));
    return rows.map((doc) => ({ ...mapPartyEdit(doc), hasReceipt: receiptIds.has(String(doc._id)) }));
  }

  return rows.map((doc) => ({
    ...mapPartyEdit(doc),
    hasReceipt: typeof doc.receipt === 'string' && doc.receipt.trim() !== '',
  }));
}

function attachOwnerNames(lots, ownerNameMap) {
  if (!ownerNameMap || !ownerNameMap.size) return lots;
  return lots.map((lot) => {
    const rawId = lot.businessOwnerId;
    const oid =
      rawId != null && typeof rawId === 'object'
        ? String(rawId._id ?? rawId.id ?? '')
        : String(rawId ?? '');
    const name = ownerNameMap.get(oid);
    if (!name) return lot;
    return { ...lot, businessOwnerId: { _id: oid, name } };
  });
}

async function fetchGhausiaLots(req, opts, ownerNameMap) {
  const filter = ghausiaLotsFilter(req, opts);
  const lots = await GhausiaLot.find(filter).sort({ receivedDate: -1 }).lean();
  return attachOwnerNames(lots, ownerNameMap);
}

async function fetchPayments(req, opts) {
  const filter = paymentsFilter(req, opts);
  const rows = await Payment.find(filter).sort({ createdAt: -1 }).lean();
  return rows.map(mapPayment);
}

/** Workspace directory for party users — derived from the owners referenced by their accessible lots. */
function partyBusinessOwnersFromLots(lotArrays, ownerNameMap) {
  const seen = new Map();
  for (const lots of lotArrays) {
    for (const lot of lots || []) {
      const raw = lot.businessOwnerId;
      const id =
        raw != null && typeof raw === 'object'
          ? String(raw._id ?? raw.id ?? '')
          : String(raw ?? '');
      if (!id || seen.has(id)) continue;
      const name =
        ownerNameMap.get(id)
        || (raw != null && typeof raw === 'object' ? String(raw.name ?? '').trim() : '');
      seen.set(id, { _id: id, id, name });
    }
  }
  return [...seen.values()];
}

router.get('/', async (req, res) => {
  try {
    const includeReceipts =
      String(req.query.includeReceipts || '').toLowerCase() === '1'
      || req.query.includeReceipts === 'true';
    const minimal =
      String(req.query.minimal || '').toLowerCase() === '1'
      || req.query.minimal === 'true';
    const receiptSelect = includeReceipts ? '' : '-receipt';

    if (isTenantAdmin(req.user)) {
      const userId = getDataOwnerId(req.user);
      const businessOwners = await BusinessOwner.find({ userId, status: 'active' })
        .sort({ isDefault: -1, createdAt: 1 })
        .lean();
      const ownerNameMap = new Map(
        businessOwners.map((owner) => [String(owner._id), owner.name]),
      );

      if (minimal) {
        const [parties, reportingLots, reportingPayments, reportingPartyEdits] = await Promise.all([
          Party.find({ userId }).sort({ name: 1 }).lean(),
          fetchGhausiaLots(req, { scopeAll: true, partyScopeAll: false }, ownerNameMap),
          fetchPayments(req, { scopeAll: true, partyScopeAll: false }),
          fetchPartyEdits(req, { scopeAll: true, partyScopeAll: false }, receiptSelect),
        ]);

        return res.json({
          businessOwners: businessOwners.map(mapOwner),
          parties,
          reporting: {
            lots: reportingLots,
            payments: reportingPayments,
            partyEdits: reportingPartyEdits,
          },
        });
      }

      const [
        parties,
        ghausiaLots,
        payments,
        partyEdits,
        reportingLots,
        reportingPayments,
        reportingPartyEdits,
      ] = await Promise.all([
        Party.find({ userId }).sort({ name: 1 }).lean(),
        fetchGhausiaLots(req, { scopeAll: false, partyScopeAll: false }, ownerNameMap),
        fetchPayments(req, { scopeAll: false, partyScopeAll: false }),
        fetchPartyEdits(req, { scopeAll: false, partyScopeAll: false }, receiptSelect),
        fetchGhausiaLots(req, { scopeAll: true, partyScopeAll: false }, ownerNameMap),
        fetchPayments(req, { scopeAll: true, partyScopeAll: false }),
        fetchPartyEdits(req, { scopeAll: true, partyScopeAll: false }, receiptSelect),
      ]);

      return res.json({
        businessOwners: businessOwners.map(mapOwner),
        parties,
        ghausiaLots,
        payments,
        partyEdits,
        reporting: {
          lots: reportingLots,
          payments: reportingPayments,
          partyEdits: reportingPartyEdits,
        },
      });
    }

    if (isParty(req.user)) {
      const [workspaceLotIds, crossLotIds, tenantOwners] = await Promise.all([
        partyAllowedLotIds(req, false),
        partyAllowedLotIds(req, true),
        BusinessOwner.find({ userId: getDataOwnerId(req.user) }).lean(),
      ]);
      const ownerNameMap = new Map(
        tenantOwners.map((owner) => [String(owner._id), owner.name]),
      );

      if (minimal) {
        const [parties, partyCrossLots, partyCrossPayments, partyCrossPartyEdits] = await Promise.all([
          Party.find({
            userId: getDataOwnerId(req.user),
            _id: req.user.partyId,
          })
            .sort({ name: 1 })
            .lean(),
          fetchGhausiaLots(req, { scopeAll: false, partyScopeAll: true }, ownerNameMap),
          fetchPayments(req, { scopeAll: false, partyScopeAll: true }),
          fetchPartyEdits(req, { scopeAll: false, partyScopeAll: true }, receiptSelect, crossLotIds),
        ]);

        return res.json({
          parties,
          businessOwners: partyBusinessOwnersFromLots([partyCrossLots], ownerNameMap),
          partyCross: {
            lots: partyCrossLots,
            payments: partyCrossPayments,
            partyEdits: partyCrossPartyEdits,
          },
        });
      }

      const [
        parties,
        ghausiaLots,
        payments,
        partyEdits,
        partyCrossLots,
        partyCrossPayments,
        partyCrossPartyEdits,
      ] = await Promise.all([
        Party.find({
          userId: getDataOwnerId(req.user),
          _id: req.user.partyId,
        })
          .sort({ name: 1 })
          .lean(),
        fetchGhausiaLots(req, { scopeAll: false, partyScopeAll: false }, ownerNameMap),
        fetchPayments(req, { scopeAll: false, partyScopeAll: false }),
        fetchPartyEdits(req, { scopeAll: false, partyScopeAll: false }, receiptSelect, workspaceLotIds),
        fetchGhausiaLots(req, { scopeAll: false, partyScopeAll: true }, ownerNameMap),
        fetchPayments(req, { scopeAll: false, partyScopeAll: true }),
        fetchPartyEdits(req, { scopeAll: false, partyScopeAll: true }, receiptSelect, crossLotIds),
      ]);

      return res.json({
        parties,
        businessOwners: partyBusinessOwnersFromLots([partyCrossLots, ghausiaLots], ownerNameMap),
        ghausiaLots,
        payments,
        partyEdits,
        partyCross: {
          lots: partyCrossLots,
          payments: partyCrossPayments,
          partyEdits: partyCrossPartyEdits,
        },
      });
    }

    return res.json({});
  } catch (error) {
    res.status(500).json({ message: 'Error loading bootstrap data', error: error.message });
  }
});

module.exports = router;
