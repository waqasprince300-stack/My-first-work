const express = require('express');
const router = express.Router();
const PartyLedger = require('../models/PartyLedger');
const { getDataOwnerId, getScopedFilter, isParty, requireAdminUser } = require('../utils/access');

const stripOwnership = ({ userId, ...data }) => data;

// Get all ledger entries
router.get('/', async (req, res) => {
  try {
    const { partyId } = req.query;
    let query = getScopedFilter(req);

    if (partyId && !isParty(req.user)) {
      query.partyId = partyId;
    }

    const includeReceipts =
      String(req.query.includeReceipts || '').toLowerCase() === '1'
      || req.query.includeReceipts === 'true';

    let ledgerQuery = PartyLedger.find(query).sort({ completeDate: -1, updatedAt: -1 });
    if (!includeReceipts) ledgerQuery = ledgerQuery.select('-receipt');
    const ledger = await ledgerQuery.lean();
    res.json(ledger);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching ledger', error: error.message });
  }
});

// Create ledger entry
router.post('/', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const entry = new PartyLedger({ ...stripOwnership(req.body), userId: getDataOwnerId(req.user), businessOwnerId: req.businessOwnerId });
    const savedEntry = await entry.save();
    res.status(201).json(savedEntry);
  } catch (error) {
    res.status(400).json({ message: 'Error creating ledger entry', error: error.message });
  }
});

// Update ledger entry
router.patch('/:id', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const entry = await PartyLedger.findOneAndUpdate(
      { _id: req.params.id, userId: getDataOwnerId(req.user), businessOwnerId: req.businessOwnerId },
      stripOwnership(req.body),
      { new: true, runValidators: true }
    );
    if (!entry) {
      return res.status(404).json({ message: 'Ledger entry not found' });
    }
    res.json(entry);
  } catch (error) {
    res.status(400).json({ message: 'Error updating ledger entry', error: error.message });
  }
});

module.exports = router;
