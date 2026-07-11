const express = require('express');
const router = express.Router();
const GhausiaLot = require('../models/GhausiaLot');
const Party = require('../models/Party');
const PartyLedger = require('../models/PartyLedger');
const PartyEdit = require('../models/PartyEdit');
const { getDataOwnerId, getScopedFilter, getPartyAllBusinessLotsFilter, getPartyAccessibleLotFilter, escapeRegexString, isParty, requireAdminUser, isTenantAdmin, toObjectId } = require('../utils/access');
const { parsePaginationQuery, paginatedJson } = require('../utils/pagination');
const { emitOrgChange } = require('../utils/realtime');
const { notifyLotRejected, notifyLotPendingReview } = require('../utils/lotNotifications');

const stripOwnership = ({ userId, ...data }) => data;
const partyEditableLotFields = new Set(['status', 'dispatchDate', 'receivedBackDate']);

const canonicalLotNumberFromDoc = (doc) =>
  String(doc.lotNumber || doc.lotNo || '').trim();

/** Same workspace = same BusinessOwner document (string/ObjectId tolerant). */
const sameBusinessWorkspace = (storedOwnerId, requestedOwnerId) =>
  String(storedOwnerId ?? '') === String(requestedOwnerId ?? '');

/**
 * Lot numbers must be unique within one business collection only.
 * Query by userId + lot number then filter by businessOwnerId string match so
 * ObjectId vs string storage does not falsely block another collection.
 */
const ensureLotNumberUniqueInCollection = async (userId, businessOwnerId, lotNumber, excludeId) => {
  const trimmed = String(lotNumber || '').trim();
  if (!trimmed) return;

  const ownerReq = String(businessOwnerId || '').trim();
  if (!ownerReq) {
    const err = new Error('Select a business collection before saving lots.');
    err.code = 'MISSING_BUSINESS_OWNER';
    throw err;
  }

  const escaped = escapeRegexString(trimmed);
  const regex = new RegExp(`^${escaped}$`, 'i');

  const uid = toObjectId(userId);
  const exclude = excludeId ? toObjectId(excludeId) : null;

  const candidates = await GhausiaLot.find({
    userId: uid,
    $or: [{ lotNumber: regex }, { lotNo: regex }],
    ...(exclude ? { _id: { $ne: exclude } } : {}),
  })
    .select('_id businessOwnerId lotNumber lotNo')
    .lean();

  const conflict = candidates.find((doc) => sameBusinessWorkspace(doc.businessOwnerId, ownerReq));
  if (!conflict) return;

  const err = new Error(`Lot number "${trimmed}" already exists in this collection. Use a different number, or switch to another business if this is intentional.`);
  err.code = 'DUPLICATE_LOT_NUMBER';
  throw err;
};

const normalizeStatus = (status) => {
  if (!status) return 'pending';
  const normalized = String(status).trim().toLowerCase();
  if (normalized === 'receivedback') return 'received back';
  if (normalized === 'inprogress') return 'in progress';
  if (normalized === 'pendingapproval') return 'pending approval';
  if (['pending', 'dispatched', 'received back', 'completed', 'in progress', 'pending approval', 'rejected'].includes(normalized)) {
    return normalized;
  }
  return 'pending';
};

const resolvePartyName = async (partyId, explicitName, userId) => {
  const normalizedName = typeof explicitName === 'string' ? explicitName.trim() : '';
  if (normalizedName) return normalizedName;
  if (!partyId) return 'Unknown';
  const party = await Party.findOne({ userId, $or: [{ _id: partyId }, { id: partyId }] });
  return party?.name || 'Unknown';
};

const normalizeLotPayload = async (payload, userId, businessOwnerId) => {
  const lotNo = payload.lotNo || payload.lotNumber || '';
  const designNo = payload.designNo || '';
  const fabric = payload.fabric === '__custom' ? payload.customFabric || '' : payload.fabric || payload.itemType || '';
  const quantity = Number(payload.quantity ?? payload.pieces ?? 0);
  const billAmount = Number(payload.billAmount || payload.totalAmount || 0);
  const totalAmount = Number(payload.totalAmount ?? billAmount ?? 0);
  const allotDate = payload.allotDate || payload.receivedDate || new Date().toISOString();
  const dispatchDate = payload.dispatchDate || null;
  const receivedBackDate = payload.receivedBackDate || null;
  const status = normalizeStatus(payload.status || 'pending');
  const notes = payload.description || payload.notes || '';
  const partyId = payload.partyId ? String(payload.partyId) : '';
  const partyName = await resolvePartyName(partyId, payload.partyName || payload.party || 'Unknown', userId);

  return {
    userId,
    businessOwnerId,
    lotNo,
    designNo,
    description: notes,
    fabric,
    customFabric: payload.customFabric || '',
    colors: Number(payload.colors || 0),
    pieces: Number(payload.pieces ?? payload.quantity ?? 0),
    allotDate: new Date(allotDate),
    partyId,
    partyName,
    lotNumber: lotNo,
    itemType: payload.itemType || fabric,
    quantity,
    unit: payload.unit || 'pieces',
    rate: Number(payload.rate || 0),
    billAmount,
    totalAmount,
    receivedDate: new Date(allotDate),
    dispatchDate: dispatchDate ? new Date(dispatchDate) : null,
    receivedBackDate: receivedBackDate ? new Date(receivedBackDate) : null,
    status,
    notes,
  };
};

const normalizeLotUpdatePayload = async (payload, userId) => {
  const normalized = stripOwnership(payload);

  if (payload.status) {
    normalized.status = normalizeStatus(payload.status);
  }

  if (payload.partyId) {
    normalized.partyId = String(payload.partyId);
  }

  if (payload.partyName || payload.party) {
    normalized.partyName = payload.partyName || payload.party;
  }

  if (!normalized.partyName && normalized.partyId) {
    normalized.partyName = await resolvePartyName(normalized.partyId, 'Unknown', userId);
  }

  if (payload.lotNumber || payload.lotNo) {
    normalized.lotNumber = payload.lotNumber || payload.lotNo;
    normalized.lotNo = payload.lotNumber || payload.lotNo;
  }

  if (payload.fabric === '__custom') {
    normalized.fabric = payload.customFabric || '';
  }

  if (payload.quantity != null) {
    normalized.quantity = Number(payload.quantity);
    normalized.pieces = Number(payload.quantity);
  } else if (payload.pieces != null) {
    normalized.pieces = Number(payload.pieces);
    normalized.quantity = Number(payload.pieces);
  }

  if (payload.billAmount != null) {
    normalized.billAmount = Number(payload.billAmount);
    if (payload.totalAmount == null) normalized.totalAmount = Number(payload.billAmount);
  }

  if (payload.totalAmount != null) {
    normalized.totalAmount = Number(payload.totalAmount);
  }

  if (payload.rejectionNote !== undefined) {
    normalized.rejectionNote = String(payload.rejectionNote || '').trim();
  }

  return normalized;
};

const syncPartyLedgerForLot = async (lot, userId, businessOwnerId) => {
  if (!lot.partyId || !lot.lotNumber) return;
  const synced = ['dispatched', 'received back', 'completed', 'in progress', 'pending approval', 'rejected'];
  const ls = normalizeStatus(lot.status);
  if (!synced.includes(ls)) return;

  const entryData = {
    userId,
    businessOwnerId,
    lotId: lot.id || lot._id || lot.lotNumber,
    lotNumber: lot.lotNumber || lot.lotNo,
    designNo: lot.designNo || '',
    description: lot.description || lot.notes || '',
    itemType: lot.itemType || lot.fabric || '',
    colors: Number(lot.colors || 0),
    quantity: Number(lot.quantity ?? lot.pieces ?? 0),
    pieces: Number(lot.pieces ?? lot.quantity ?? 0),
    allotDate: lot.allotDate ? new Date(lot.allotDate) : new Date(),
    completeDate: lot.receivedBackDate ? new Date(lot.receivedBackDate) : null,
    partyId: lot.partyId,
    partyName: lot.partyName || 'Unknown',
    status: ls,
    billAmount: Number(lot.billAmount || 0),
    receipt: lot.receipt || '',
    notes: lot.notes || '',
  };

  const existing = await PartyLedger.findOne({ userId, businessOwnerId, $or: [{ lotId: entryData.lotId }, { lotNumber: entryData.lotNumber }] });
  if (existing) {
    Object.assign(existing, entryData);
    await existing.save();
    return existing;
  }

  const newEntry = new PartyLedger(entryData);
  await newEntry.save();
  return newEntry;
};

// Get all Ghausia lots
router.get('/', async (req, res) => {
  try {
    const partyAllBiz = String(req.query.partyScope || '').toLowerCase() === 'all' && isParty(req.user);
    const allWorkspaces = String(req.query.scope || '').toLowerCase() === 'all' && isTenantAdmin(req.user);

    let filter;
    if (partyAllBiz) {
      filter = getPartyAllBusinessLotsFilter(req.user);
    } else if (allWorkspaces) {
      filter = { userId: getDataOwnerId(req.user) };
    } else {
      filter = getScopedFilter(req);
    }

    const statusQ = String(req.query.status || '').trim();
    if (statusQ) {
      filter.status = new RegExp(`^${escapeRegexString(statusQ)}$`, 'i');
    }

    const pagination = parsePaginationQuery(req);
    const sort = { receivedDate: -1 };
    if (pagination.paginate) {
      const [items, total] = await Promise.all([
        GhausiaLot.find(filter).sort(sort).skip(pagination.skip).limit(pagination.limit).lean(),
        GhausiaLot.countDocuments(filter),
      ]);
      return paginatedJson(res, items, total, pagination.page, pagination.limit);
    }

    const lots = await GhausiaLot.find(filter).sort(sort).lean();
    res.json(lots);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching lots', error: error.message });
  }
});

// Admin: approve party completion submission (pending approval → billable received back)
router.post('/:id/approve-completion', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const lot = await GhausiaLot.findOne({ _id: req.params.id, userId });
    if (!lot) {
      return res.status(404).json({ message: 'Lot not found' });
    }
    const cur = normalizeStatus(lot.status);
    if (cur !== 'pending approval') {
      return res.status(400).json({ message: 'Lot is not awaiting approval' });
    }

    lot.status = 'received back';
    lot.rejectionNote = '';
    lot.completionApprovedAt = new Date();

    const lotIdStr = String(lot._id);
    const peDoc = await PartyEdit.findOne({
      lotId: lotIdStr,
      userId,
      businessOwnerId: lot.businessOwnerId,
    });

    const ownerBillingChoice = String(req.body?.ownerBillingChoice || '').trim();
    const partyBill = Number(peDoc?.partyBillAmount ?? 0);
    if (ownerBillingChoice === 'sync_party') {
      lot.billAmount = partyBill;
    } else if (ownerBillingChoice === 'custom_ghausia') {
      const custom = Number(req.body?.ownerBillAmount);
      if (Number.isFinite(custom) && custom >= 0) {
        lot.billAmount = custom;
        lot.totalAmount = custom;
      }
    } else if (ownerBillingChoice === 'delta_only' && peDoc?.pendingRevision) {
      const fromA = Number(peDoc.pendingRevision.fromAmount ?? 0);
      const toA = Number(peDoc.pendingRevision.toAmount ?? 0);
      const delta = toA - fromA;
      if (delta > 0) lot.billAmount = delta;
    }

    await lot.save();

    await PartyEdit.findOneAndUpdate(
      {
        lotId: lotIdStr,
        userId,
        businessOwnerId: lot.businessOwnerId,
      },
      {
        $set: {
          overrideStatus: 'Completed',
          completeDate: lot.receivedBackDate || new Date(),
        },
        $setOnInsert: {
          lotId: lotIdStr,
          userId,
          businessOwnerId: lot.businessOwnerId,
        },
        $unset: { pendingRevision: '' },
      },
      { upsert: true, new: true, runValidators: true },
    );

    await syncPartyLedgerForLot(lot.toObject({ virtuals: true }), userId, lot.businessOwnerId);
    res.json(lot);
    emitOrgChange(req, 'lot', { lotId: String(lot._id) });
  } catch (error) {
    res.status(400).json({ message: 'Could not approve lot', error: error.message });
  }
});

// Admin: reject party completion — lot becomes rejected until party resubmits
router.post('/:id/reject-completion', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const note = String(req.body?.rejectionNote ?? req.body?.rejectionReason ?? '').trim();
    if (!note) {
      return res.status(400).json({ message: 'Rejection description is required' });
    }

    const lot = await GhausiaLot.findOne({ _id: req.params.id, userId });
    if (!lot) {
      return res.status(404).json({ message: 'Lot not found' });
    }
    const cur = normalizeStatus(lot.status);
    if (cur !== 'pending approval') {
      return res.status(400).json({ message: 'Lot is not awaiting approval' });
    }

    lot.status = 'rejected';
    lot.rejectionNote = note;
    await lot.save();

    const lotIdStr = String(lot._id);
    await PartyEdit.findOneAndUpdate(
      {
        lotId: lotIdStr,
        userId,
        businessOwnerId: lot.businessOwnerId,
      },
      {
        $set: {
          overrideStatus: 'Rejected',
        },
        $setOnInsert: {
          lotId: lotIdStr,
          userId,
          businessOwnerId: lot.businessOwnerId,
        },
        $unset: { pendingRevision: '' },
      },
      { upsert: true, new: true, runValidators: true },
    );

    await syncPartyLedgerForLot(lot.toObject({ virtuals: true }), userId, lot.businessOwnerId);
    res.json(lot);
    const lotObj = lot.toObject({ virtuals: true });
    emitOrgChange(req, 'lot', {
      lotId: String(lot._id),
      action: 'lot_rejected',
      partyId: String(lot.partyId || ''),
      linkPath: `/party-ledger?lotId=${encodeURIComponent(String(lot._id))}`,
    });
    void notifyLotRejected({ lot: lotObj, note, ownerId: userId });
  } catch (error) {
    res.status(400).json({ message: 'Could not reject lot', error: error.message });
  }
});

// Get single lot
router.get('/:id', async (req, res) => {
  try {
    const filter = isParty(req.user)
      ? getPartyAccessibleLotFilter(req.user, { _id: req.params.id })
      : getScopedFilter(req, { _id: req.params.id });
    const lot = await GhausiaLot.findOne(filter).populate('businessOwnerId', 'name');
    if (!lot) {
      return res.status(404).json({ message: 'Lot not found' });
    }
    res.json(lot);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching lot', error: error.message });
  }
});

// Create lot
router.post('/', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const payload = await normalizeLotPayload(stripOwnership(req.body), userId, req.businessOwnerId);
    await ensureLotNumberUniqueInCollection(userId, req.businessOwnerId, canonicalLotNumberFromDoc(payload));

    const lot = new GhausiaLot(payload);
    const savedLot = await lot.save();
    await syncPartyLedgerForLot(savedLot, userId, req.businessOwnerId);
    res.status(201).json(savedLot);
    emitOrgChange(req, 'lot', { lotId: String(savedLot._id) });
  } catch (error) {
    if (error.code === 'DUPLICATE_LOT_NUMBER') {
      return res.status(409).json({ message: error.message });
    }
    if (error.code === 'MISSING_BUSINESS_OWNER') {
      return res.status(400).json({ message: error.message });
    }
    res.status(400).json({ message: 'Error creating lot', error: error.message });
  }
});

// Update lot
router.patch('/:id', async (req, res) => {
  try {
    const userId = getDataOwnerId(req.user);
    const lotQuery = isParty(req.user)
      ? getPartyAccessibleLotFilter(req.user, { _id: req.params.id })
      : getScopedFilter(req, { _id: req.params.id });
    const body = isParty(req.user)
      ? Object.fromEntries(Object.entries(req.body).filter(([key]) => partyEditableLotFields.has(key)))
      : req.body;
    const existing = await GhausiaLot.findOne(lotQuery);
    if (!existing) {
      return res.status(404).json({ message: 'Lot not found' });
    }

    const payload = await normalizeLotUpdatePayload(body, userId);
    delete payload.completionApprovedAt;

    if (!isParty(req.user)) {
      const cur = normalizeStatus(existing.status);
      const next = payload.status != null ? normalizeStatus(payload.status) : cur;
      const hasApprovalTs = Boolean(existing.completionApprovedAt);
      if (cur === 'pending approval' && next === 'received back') {
        payload.completionApprovedAt = new Date();
      } else if (next === 'received back' && cur !== 'received back' && !hasApprovalTs) {
        payload.completionApprovedAt = new Date();
      } else if (next === 'completed' && cur !== 'completed' && !hasApprovalTs) {
        payload.completionApprovedAt = new Date();
      }
    }

    let becamePendingApproval = false;
    if (isParty(req.user) && payload.status) {
      const next = normalizeStatus(payload.status);
      const cur = normalizeStatus(existing.status);
      if (next === 'received back' || next === 'completed') {
        return res.status(403).json({
          message:
            'You cannot mark a lot billable directly. Submit for completion from your Party Ledger.',
        });
      }
      if (next === 'pending approval') {
        if (cur === 'rejected') {
          return res.status(400).json({
            message:
              'This lot was rejected — switch it back to In Progress before submitting again.',
          });
        }
        // Allow pending: ledger often shows In Progress while Ghausia row is still "pending" until dispatch is recorded.
        const allowedPrev = ['pending', 'dispatched', 'in progress'];
        if (!allowedPrev.includes(cur)) {
          return res.status(400).json({
            message:
              'You can submit for approval only when the lot is pending, dispatched, or in progress.',
          });
        }
        if (cur !== 'pending approval') {
          becamePendingApproval = true;
        }
      }
      if (next === 'dispatched' && cur === 'rejected') {
        payload.rejectionNote = '';
      }
    }

    const merged = { ...existing.toObject(), ...payload };
    await ensureLotNumberUniqueInCollection(
      userId,
      existing.businessOwnerId,
      canonicalLotNumberFromDoc(merged),
      existing._id,
    );

    const lot = await GhausiaLot.findOneAndUpdate(
      lotQuery,
      payload,
      { new: true, runValidators: true }
    );
    if (!lot) {
      return res.status(404).json({ message: 'Lot not found' });
    }
    await syncPartyLedgerForLot(
      lot.toObject({ virtuals: true }),
      userId,
      lot.businessOwnerId,
    );
    res.json(lot);
    const lotObj = lot.toObject({ virtuals: true });
    if (becamePendingApproval) {
      emitOrgChange(req, 'lot', {
        lotId: String(lot._id),
        action: 'lot_pending_review',
        linkPath: `/review-lots?lotId=${encodeURIComponent(String(lot._id))}`,
      });
      void notifyLotPendingReview({ lot: lotObj, ownerId: userId });
    } else {
      emitOrgChange(req, 'lot', { lotId: String(lot._id) });
    }
  } catch (error) {
    if (error.code === 'DUPLICATE_LOT_NUMBER') {
      return res.status(409).json({ message: error.message });
    }
    if (error.code === 'MISSING_BUSINESS_OWNER') {
      return res.status(400).json({ message: error.message });
    }
    res.status(400).json({ message: 'Error updating lot', error: error.message });
  }
});

// Delete lot
router.delete('/:id', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const lot = await GhausiaLot.findOneAndDelete({ _id: req.params.id, userId: getDataOwnerId(req.user), businessOwnerId: req.businessOwnerId });
    if (!lot) {
      return res.status(404).json({ message: 'Lot not found' });
    }
    res.json({ message: 'Lot deleted successfully' });
    emitOrgChange(req, 'lot', { lotId: String(lot._id) });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting lot', error: error.message });
  }
});

module.exports = router;
