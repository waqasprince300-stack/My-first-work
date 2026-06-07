const express = require('express');
const mongoose = require('mongoose');
const BusinessOwner = require('../models/BusinessOwner');
const PartyEdit = require('../models/PartyEdit');
const PartyLedger = require('../models/PartyLedger');
const Payment = require('../models/Payment');
const GhausiaLot = require('../models/GhausiaLot');
const Party = require('../models/Party');
const Collection = require('../models/Collection');
const RateCalculation = require('../models/RateCalculation');
const SavedDesign = require('../models/SavedDesign');
const User = require('../models/User');
const { getDataOwnerId, requireAdminUser } = require('../utils/access');

const router = express.Router();

const normalize = (doc) => ({ ...doc.toObject(), id: String(doc._id) });

router.get('/', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const owners = await BusinessOwner.find({
      userId: getDataOwnerId(req.user),
      status: 'active',
    })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean();
    res.json(owners.map((doc) => ({ ...doc, id: String(doc._id) })));
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

/** DELETE workspace (BusinessOwner) and scoped data. Requires ?force=true if related rows exist. */
router.delete('/:id', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const rawId = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      return res.status(400).json({ message: 'Invalid workspace id' });
    }

    const uid = getDataOwnerId(req.user);
    const owner = await BusinessOwner.findOne({
      _id: rawId,
      userId: uid,
      status: 'active',
    });

    if (!owner) {
      return res.status(404).json({ message: 'Business owner not found' });
    }

    const bid = owner._id;
    const workspaceFilter = { userId: uid, businessOwnerId: bid };
    const force = req.query.force === 'true' || req.query.force === '1';

    const countWorkspaceData = async () => {
      const [
        partyEdits,
        partyLedger,
        payments,
        ghausiaLots,
        parties,
        collections,
        rateCalculations,
        savedDesigns,
        partyUsers,
      ] = await Promise.all([
        PartyEdit.countDocuments(workspaceFilter),
        PartyLedger.countDocuments(workspaceFilter),
        Payment.countDocuments(workspaceFilter),
        GhausiaLot.countDocuments(workspaceFilter),
        Party.countDocuments(workspaceFilter),
        Collection.countDocuments(workspaceFilter),
        RateCalculation.countDocuments(workspaceFilter),
        SavedDesign.countDocuments(workspaceFilter),
        User.countDocuments({
          role: 'party',
          ownerId: uid,
          businessOwnerId: String(bid),
        }),
      ]);
      return {
        partyEdits,
        partyLedger,
        payments,
        ghausiaLots,
        parties,
        collections,
        rateCalculations,
        savedDesigns,
        partyUsers,
      };
    };

    const counts = await countWorkspaceData();
    const totalRelated = Object.values(counts).reduce((a, n) => a + n, 0);

    if (!force && totalRelated > 0) {
      return res.status(409).json({
        message:
          'This workspace has data. Repeat the request with ?force=true to delete the workspace, remove all related records, and disable party logins scoped to this workspace.',
        counts,
      });
    }

    await Promise.all([
      PartyEdit.deleteMany(workspaceFilter),
      PartyLedger.deleteMany(workspaceFilter),
      Payment.deleteMany(workspaceFilter),
      GhausiaLot.deleteMany(workspaceFilter),
      Party.deleteMany(workspaceFilter),
      Collection.deleteMany(workspaceFilter),
      RateCalculation.deleteMany(workspaceFilter),
      SavedDesign.deleteMany(workspaceFilter),
    ]);

    await User.updateMany(
      {
        role: 'party',
        ownerId: uid,
        businessOwnerId: String(bid),
      },
      {
        $set: {
          status: 'disabled',
          disabledAt: new Date(),
          partyId: '',
          partyName: '',
          businessOwnerId: '',
        },
      },
    );

    await BusinessOwner.findByIdAndDelete(bid);
    return res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: 'Error deleting business owner', error: error.message });
  }
});

module.exports = router;
