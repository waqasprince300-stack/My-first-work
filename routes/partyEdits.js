const express = require('express');
const router = express.Router();
const PartyEdit = require('../models/PartyEdit');
const GhausiaLot = require('../models/GhausiaLot');
const { getBusinessOwnerFilter, getDataOwnerId, getOwnerFilter, getPartyAllBusinessLotsFilter, getPartyAccessibleLotFilter, isParty, requireAdminUser, isTenantAdmin } = require('../utils/access');
const { parsePaginationQuery, paginatedJson } = require('../utils/pagination');
const { emitOrgChange } = require('../utils/realtime');

const stripOwnership = ({ userId, ...data }) => data;

const PARTY_EDIT_PATCH_FIELDS = [
  'completeDate',
  'partyBillAmount',
  'receipt',
  'lotImages',
  'notes',
  'overrideStatus',
  'pendingRevision',
  'billRevisionRequest',
  'amountChangeNote',
  'allotDate',
];

const pickPartyEditPatch = (body) => {
  const out = {};
  for (const key of PARTY_EDIT_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
};

const getAllowedPartyLotIds = async (req) => {
  if (!isParty(req.user)) return null;
  const lots = await GhausiaLot.find({
    userId: getDataOwnerId(req.user),
    partyId: String(req.user.partyId || ''),
  })
    .select('_id')
    .lean();
  return lots.map((lot) => String(lot._id));
};

// Get all party edits
router.get('/', async (req, res) => {
  try {
    const partyLedgerAll = String(req.query.partyScope || '').toLowerCase() === 'all' && isParty(req.user);
    let allowedLotIds = null;
    if (partyLedgerAll) {
      const lots = await GhausiaLot.find(getPartyAllBusinessLotsFilter(req.user))
        .select('_id')
        .lean();
      allowedLotIds = lots.map((lot) => String(lot._id));
    } else if (isParty(req.user)) {
      allowedLotIds = await getAllowedPartyLotIds(req);
    }

    const allWorkspaces = String(req.query.scope || '').toLowerCase() === 'all' && isTenantAdmin(req.user);
    const bizFilter = allWorkspaces || partyLedgerAll ? {} : getBusinessOwnerFilter(req);

    const filter = {
      ...getOwnerFilter(req),
      ...bizFilter,
      ...(allowedLotIds !== null ? { lotId: { $in: allowedLotIds } } : {}),
    };
    const includeReceipts =
      String(req.query.includeReceipts || '').toLowerCase() === '1'
      || req.query.includeReceipts === 'true';
    const pagination = parsePaginationQuery(req);
    // Base64 images (bill receipt + lot pictures) are heavy — excluded unless explicitly requested.
    const heavyImageSelect = '-receipt -lotImages';
    let query = PartyEdit.find(filter).sort({ createdAt: -1 });
    if (!includeReceipts) query = query.select(heavyImageSelect);
    if (pagination.paginate) {
      const [rows, total] = await Promise.all([
        PartyEdit.find(filter)
          .sort({ createdAt: -1 })
          .select(includeReceipts ? undefined : heavyImageSelect)
          .skip(pagination.skip)
          .limit(pagination.limit)
          .lean(),
        PartyEdit.countDocuments(filter),
      ]);
      return paginatedJson(
        res,
        rows.map((p) => ({ ...p, id: String(p._id) })),
        total,
        pagination.page,
        pagination.limit,
      );
    }
    const partyEdits = await query.lean();
    res.json(partyEdits.map((p) => ({ ...p, id: String(p._id) })));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching party edits', error: error.message });
  }
});

// Get party edit for a single lot (optional receipt for lazy loading)
router.get('/lot/:lotId', async (req, res) => {
  try {
    const lotIdStr = String(req.params.lotId || '').trim();
    const userId = getDataOwnerId(req.user);
    let businessOwnerId = req.businessOwnerId;

    const includeReceipts =
      String(req.query.includeReceipts || '').toLowerCase() === '1'
      || req.query.includeReceipts === 'true';

    if (isParty(req.user)) {
      const lot = await GhausiaLot.findOne(
        getPartyAccessibleLotFilter(req.user, { _id: lotIdStr }),
      );
      if (!lot) {
        return res.status(404).json({ message: 'Lot not found for this party' });
      }
      businessOwnerId = String(lot.businessOwnerId ?? '').trim();
    } else if (isTenantAdmin(req.user)) {
      const queryBiz = String(req.query.businessOwnerId || '').trim();
      if (queryBiz) {
        businessOwnerId = queryBiz;
      } else {
        const lot = await GhausiaLot.findOne({ _id: lotIdStr, userId })
          .select('businessOwnerId')
          .lean();
        if (lot?.businessOwnerId) {
          businessOwnerId = String(lot.businessOwnerId);
        }
      }
    }

    const receiptSelect = includeReceipts ? undefined : '-receipt -lotImages';
    let row = await PartyEdit.findOne({ lotId: lotIdStr, userId, businessOwnerId })
      .select(receiptSelect)
      .lean();

    // Both the admin and the party ledger span multiple workspaces, so a businessOwnerId/header
    // mismatch (e.g. legacy rows saved with an empty businessOwnerId) must not hide an existing
    // row. For a party the lot's ownership was already validated above, and `userId` pins the
    // tenant, so this businessOwnerId-agnostic fallback is safe for party and admin alike.
    if (!row) {
      row = await PartyEdit.findOne({ lotId: lotIdStr, userId })
        .select(receiptSelect)
        .lean();
    }

    if (!row) {
      return res.status(404).json({ message: 'Party edit not found' });
    }
    res.json({ ...row, id: String(row._id) });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching party edit', error: error.message });
  }
});

// Get single party edit
router.get('/:id', async (req, res) => {
  try {
    const allowedLotIds = await getAllowedPartyLotIds(req);
    const partyEdit = await PartyEdit.findOne({
      _id: req.params.id,
      ...getOwnerFilter(req),
      ...getBusinessOwnerFilter(req),
      ...(allowedLotIds ? { lotId: { $in: allowedLotIds } } : {}),
    });
    if (!partyEdit) {
      return res.status(404).json({ message: 'Party edit not found' });
    }
    res.json(partyEdit);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching party edit', error: error.message });
  }
});

// Create party edit
router.post('/', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const partyEdit = new PartyEdit({ ...stripOwnership(req.body), userId: getDataOwnerId(req.user), businessOwnerId: req.businessOwnerId });
    const savedPartyEdit = await partyEdit.save();
    res.status(201).json({ ...savedPartyEdit.toObject(), id: savedPartyEdit._id.toString() });
    emitOrgChange(req, 'partyEdit', { lotId: String(savedPartyEdit.lotId || '') });
  } catch (error) {
    res.status(400).json({ message: 'Error creating party edit', error: error.message });
  }
});

// Update party edit by MongoDB _id
router.patch('/:id', async (req, res) => {
  try {
    const allowedLotIds = await getAllowedPartyLotIds(req);
    const partyEdit = await PartyEdit.findOneAndUpdate(
      {
        _id: req.params.id,
        ...getOwnerFilter(req),
        ...getBusinessOwnerFilter(req),
        ...(allowedLotIds ? { lotId: { $in: allowedLotIds } } : {}),
      },
      stripOwnership(pickPartyEditPatch(req.body)),
      { new: true, runValidators: true }
    );
    if (!partyEdit) {
      return res.status(404).json({ message: 'Party edit not found' });
    }
    res.json({ ...partyEdit.toObject(), id: partyEdit._id.toString() });
    emitOrgChange(req, 'partyEdit', { lotId: String(partyEdit.lotId || '') });
  } catch (error) {
    res.status(400).json({ message: 'Error updating party edit', error: error.message });
  }
});

// Upsert party edit by lotId
router.put('/lot/:lotId', async (req, res) => {
  try {
    const { lotId } = req.params;
    const userId = getDataOwnerId(req.user);
    let businessOwnerId = req.businessOwnerId;

    if (isParty(req.user)) {
      const lot = await GhausiaLot.findOne(
        getPartyAccessibleLotFilter(req.user, { _id: lotId }),
      );
      if (!lot) {
        return res.status(404).json({ message: 'Lot not found for this party' });
      }
      businessOwnerId = String(lot.businessOwnerId ?? '').trim();
    }

    const data = { ...stripOwnership(req.body), lotId, userId, businessOwnerId };
    const unset = {};
    if (Object.prototype.hasOwnProperty.call(data, 'pendingRevision') && data.pendingRevision === null) {
      unset.pendingRevision = '';
      delete data.pendingRevision;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'billRevisionRequest') && data.billRevisionRequest === null) {
      unset.billRevisionRequest = '';
      delete data.billRevisionRequest;
    }
    const update =
      Object.keys(unset).length > 0
        ? { $set: data, $unset: unset }
        : data;

    const partyEdit = await PartyEdit.findOneAndUpdate(
      { lotId, userId, businessOwnerId },
      update,
      { new: true, upsert: true, runValidators: true }
    );
    res.json({ ...partyEdit.toObject(), id: partyEdit._id.toString() });
    emitOrgChange(req, 'partyEdit', { lotId: String(lotId) });
  } catch (error) {
    res.status(400).json({ message: 'Error upserting party edit', error: error.message });
  }
});

// Delete party edit
router.delete('/:id', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const partyEdit = await PartyEdit.findOneAndDelete({ _id: req.params.id, userId: getDataOwnerId(req.user), businessOwnerId: req.businessOwnerId });
    if (!partyEdit) {
      return res.status(404).json({ message: 'Party edit not found' });
    }
    res.json({ message: 'Party edit deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting party edit', error: error.message });
  }
});

module.exports = router;
