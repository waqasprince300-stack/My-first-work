const express = require('express');
const router = express.Router();
const PartyEdit = require('../models/PartyEdit');

const getUserId = (req) => req.user._id;
const stripOwnership = ({ userId, ...data }) => data;

// Get all party edits
router.get('/', async (req, res) => {
  try {
    const partyEdits = await PartyEdit.find({ userId: getUserId(req) }).sort({ createdAt: -1 });
    res.json(partyEdits.map(p => ({ ...p.toObject(), id: p._id.toString() })));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching party edits', error: error.message });
  }
});

// Get single party edit
router.get('/:id', async (req, res) => {
  try {
    const partyEdit = await PartyEdit.findOne({ _id: req.params.id, userId: getUserId(req) });
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
    const partyEdit = new PartyEdit({ ...stripOwnership(req.body), userId: getUserId(req) });
    const savedPartyEdit = await partyEdit.save();
    res.status(201).json({ ...savedPartyEdit.toObject(), id: savedPartyEdit._id.toString() });
  } catch (error) {
    res.status(400).json({ message: 'Error creating party edit', error: error.message });
  }
});

// Update party edit by MongoDB _id
router.patch('/:id', async (req, res) => {
  try {
    const partyEdit = await PartyEdit.findOneAndUpdate(
      { _id: req.params.id, userId: getUserId(req) },
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
    const userId = getUserId(req);
    const partyEdit = await PartyEdit.findOneAndUpdate(
      { lotId, userId },
      { ...stripOwnership(req.body), lotId, userId },
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
    const partyEdit = await PartyEdit.findOneAndDelete({ _id: req.params.id, userId: getUserId(req) });
    if (!partyEdit) {
      return res.status(404).json({ message: 'Party edit not found' });
    }
    res.json({ message: 'Party edit deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting party edit', error: error.message });
  }
});

module.exports = router;
