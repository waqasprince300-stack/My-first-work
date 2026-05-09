const express = require('express');
const router = express.Router();
const GhausiaLot = require('../models/GhausiaLot');
const Party = require('../models/Party');
const PartyLedger = require('../models/PartyLedger');

const getUserId = (req) => req.user._id;
const stripOwnership = ({ userId, ...data }) => data;

const normalizeStatus = (status) => {
  if (!status) return 'pending';
  const normalized = String(status).trim().toLowerCase();
  if (normalized === 'receivedback') return 'received back';
  if (normalized === 'inprogress') return 'in progress';
  if (['pending', 'dispatched', 'received back', 'completed', 'in progress'].includes(normalized)) {
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

const normalizeLotPayload = async (payload, userId) => {
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

  return normalized;
};

const syncPartyLedgerForLot = async (lot, userId) => {
  if (!lot.partyId || !lot.lotNumber) return;
  if (lot.status !== 'dispatched' && lot.status !== 'received back' && lot.status !== 'completed') return;

  const entryData = {
    userId,
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
    status: lot.status,
    billAmount: Number(lot.billAmount || 0),
    receipt: lot.receipt || '',
    notes: lot.notes || '',
  };

  const existing = await PartyLedger.findOne({ userId, $or: [{ lotId: entryData.lotId }, { lotNumber: entryData.lotNumber }] });
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
    const lots = await GhausiaLot.find({ userId: getUserId(req) }).sort({ receivedDate: -1 });
    res.json(lots);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching lots', error: error.message });
  }
});

// Get single lot
router.get('/:id', async (req, res) => {
  try {
    const lot = await GhausiaLot.findOne({ _id: req.params.id, userId: getUserId(req) });
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
    const userId = getUserId(req);
    const payload = await normalizeLotPayload(stripOwnership(req.body), userId);
    const lot = new GhausiaLot(payload);
    const savedLot = await lot.save();
    await syncPartyLedgerForLot(savedLot, userId);
    res.status(201).json(savedLot);
  } catch (error) {
    res.status(400).json({ message: 'Error creating lot', error: error.message });
  }
});

// Update lot
router.patch('/:id', async (req, res) => {
  try {
    const userId = getUserId(req);
    const payload = await normalizeLotUpdatePayload(req.body, userId);
    const lot = await GhausiaLot.findOneAndUpdate(
      { _id: req.params.id, userId },
      payload,
      { new: true, runValidators: true }
    );
    if (!lot) {
      return res.status(404).json({ message: 'Lot not found' });
    }
    await syncPartyLedgerForLot(lot, userId);
    res.json(lot);
  } catch (error) {
    res.status(400).json({ message: 'Error updating lot', error: error.message });
  }
});

// Delete lot
router.delete('/:id', async (req, res) => {
  try {
    const lot = await GhausiaLot.findOneAndDelete({ _id: req.params.id, userId: getUserId(req) });
    if (!lot) {
      return res.status(404).json({ message: 'Lot not found' });
    }
    res.json({ message: 'Lot deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting lot', error: error.message });
  }
});

module.exports = router;
