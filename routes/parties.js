const express = require('express');
const router = express.Router();
const Party = require('../models/Party');

const getUserId = (req) => req.user._id;
const stripOwnership = ({ userId, ...data }) => data;

// Get all parties
router.get('/', async (req, res) => {
  try {
    const parties = await Party.find({ userId: getUserId(req) }).sort({ name: 1 });
    res.json(parties);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching parties', error: error.message });
  }
});

// Get single party
router.get('/:id', async (req, res) => {
  try {
    const party = await Party.findOne({ _id: req.params.id, userId: getUserId(req) });
    if (!party) {
      return res.status(404).json({ message: 'Party not found' });
    }
    res.json(party);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching party', error: error.message });
  }
});

// Create party
router.post('/', async (req, res) => {
  try {
    const party = new Party({ ...stripOwnership(req.body), userId: getUserId(req) });
    const savedParty = await party.save();
    res.status(201).json(savedParty);
  } catch (error) {
    res.status(400).json({ message: 'Error creating party', error: error.message });
  }
});

// Update party
router.patch('/:id', async (req, res) => {
  try {
    const party = await Party.findOneAndUpdate(
      { _id: req.params.id, userId: getUserId(req) },
      stripOwnership(req.body),
      { new: true, runValidators: true }
    );
    if (!party) {
      return res.status(404).json({ message: 'Party not found' });
    }
    res.json(party);
  } catch (error) {
    res.status(400).json({ message: 'Error updating party', error: error.message });
  }
});

// Delete party
router.delete('/:id', async (req, res) => {
  try {
    const party = await Party.findOneAndDelete({ _id: req.params.id, userId: getUserId(req) });
    if (!party) {
      return res.status(404).json({ message: 'Party not found' });
    }
    res.json({ message: 'Party deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting party', error: error.message });
  }
});

module.exports = router;
