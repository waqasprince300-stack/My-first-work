const express = require('express');
const router = express.Router();
const PartyLedger = require('../models/PartyLedger');

const getUserId = (req) => req.user._id;
const stripOwnership = ({ userId, ...data }) => data;

// Get all ledger entries
router.get('/', async (req, res) => {
  try {
    const { partyId } = req.query;
    let query = { userId: getUserId(req) };
    
    if (partyId) {
      query.partyId = partyId;
    }
    
    const ledger = await PartyLedger.find(query).sort({ date: -1 });
    res.json(ledger);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching ledger', error: error.message });
  }
});

// Create ledger entry
router.post('/', async (req, res) => {
  try {
    const entry = new PartyLedger({ ...stripOwnership(req.body), userId: getUserId(req) });
    const savedEntry = await entry.save();
    res.status(201).json(savedEntry);
  } catch (error) {
    res.status(400).json({ message: 'Error creating ledger entry', error: error.message });
  }
});

// Update ledger entry
router.patch('/:id', async (req, res) => {
  try {
    const entry = await PartyLedger.findOneAndUpdate(
      { _id: req.params.id, userId: getUserId(req) },
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
