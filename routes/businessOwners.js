const express = require('express');
const BusinessOwner = require('../models/BusinessOwner');
const { ensureDefaultBusinessOwner, getDataOwnerId, requireAdminUser } = require('../utils/access');

const router = express.Router();

const normalize = (doc) => ({ ...doc.toObject(), id: String(doc._id) });

router.get('/', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    await ensureDefaultBusinessOwner(req.user);
    const owners = await BusinessOwner.find({
      userId: getDataOwnerId(req.user),
      status: 'active',
    }).sort({ isDefault: -1, createdAt: 1 });
    res.json(owners.map(normalize));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching business owners', error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const name = String(req.body.name || '').trim();

    if (!name) {
      return res.status(400).json({ message: 'Business owner name is required' });
    }

    const owner = await BusinessOwner.create({
      userId: getDataOwnerId(req.user),
      name,
      phone: String(req.body.phone || '').trim(),
      address: String(req.body.address || '').trim(),
      isDefault: false,
    });

    res.status(201).json(normalize(owner));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Business owner already exists' });
    }
    res.status(400).json({ message: 'Error creating business owner', error: error.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const owner = await BusinessOwner.findOneAndUpdate(
      { _id: req.params.id, userId: getDataOwnerId(req.user) },
      {
        name: String(req.body.name || '').trim(),
        phone: String(req.body.phone || '').trim(),
        address: String(req.body.address || '').trim(),
      },
      { new: true, runValidators: true }
    );

    if (!owner) {
      return res.status(404).json({ message: 'Business owner not found' });
    }

    res.json(normalize(owner));
  } catch (error) {
    res.status(400).json({ message: 'Error updating business owner', error: error.message });
  }
});

module.exports = router;
