const express = require('express');
const router = express.Router();
const Collection = require('../models/Collection');

const getUserId = (req) => req.user._id;
const stripOwnership = ({ userId, ...data }) => data;

// Get all collections
router.get('/', async (req, res) => {
  try {
    const collections = await Collection.find({ userId: getUserId(req) }).sort({ date: -1 });
    res.json(collections);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching collections', error: error.message });
  }
});

// Get single collection
router.get('/:id', async (req, res) => {
  try {
    const collection = await Collection.findOne({ _id: req.params.id, userId: getUserId(req) });
    if (!collection) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    res.json(collection);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching collection', error: error.message });
  }
});

// Create collection
router.post('/', async (req, res) => {
  try {
    const collection = new Collection({ ...stripOwnership(req.body), userId: getUserId(req) });
    const savedCollection = await collection.save();
    res.status(201).json(savedCollection);
  } catch (error) {
    res.status(400).json({ message: 'Error creating collection', error: error.message });
  }
});

// Update collection
router.patch('/:id', async (req, res) => {
  try {
    const collection = await Collection.findOneAndUpdate(
      { _id: req.params.id, userId: getUserId(req) },
      stripOwnership(req.body),
      { new: true, runValidators: true }
    );
    if (!collection) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    res.json(collection);
  } catch (error) {
    res.status(400).json({ message: 'Error updating collection', error: error.message });
  }
});

// Delete collection
router.delete('/:id', async (req, res) => {
  try {
    const collection = await Collection.findOneAndDelete({ _id: req.params.id, userId: getUserId(req) });
    if (!collection) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    res.json({ message: 'Collection deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting collection', error: error.message });
  }
});

module.exports = router;
