const express = require('express');
const router = express.Router();
const PartyEdit = require('../models/PartyEdit');
const GhausiaLot = require('../models/GhausiaLot');
const { getBusinessOwnerFilter, getDataOwnerId, getOwnerFilter, getPartyAllBusinessLotsFilter, getPartyAccessibleLotFilter, isParty, requireAdminUser, isTenantAdmin } = require('../utils/access');

const stripOwnership = ({ userId, ...data }) => data;

const getAllowedPartyLotIds = async (req) => {
  if (!isParty(req.user)) return null;
  const lots = await GhausiaLot.find({
    userId: getDataOwnerId(req.user),
    partyId: String(req.user.partyId || ''),
  }).select('_id');
  return lots.map((lot) => String(lot._id));
};

// Get all party edits
router.get('/', async (req, res) => {
  try {
    const partyLedgerAll = String(req.query.partyScope || '').toLowerCase() === 'all' && isParty(req.user);
    let allowedLotIds = null;
    if (partyLedgerAll) {
      const lots = await GhausiaLot.find(getPartyAllBusinessLotsFilter(req.user)).select('_id');
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
    const partyEdits = await PartyEdit.find(filter).sort({ createdAt: -1 });
    res.json(partyEdits.map(p => ({ ...p.toObject(), id: p._id.toString() })));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching party edits', error: error.message });
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
      stripOwnership(req.body),
      { new: true, runValidators: true }
    );
    if (!partyEdit) {
      return res.status(404).json({ message: 'Party edit not found' });
    }
    res.json({ ...partyEdit.toObject(), id: partyEdit._id.toString() });
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
