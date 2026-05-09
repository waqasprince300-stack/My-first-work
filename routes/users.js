const express = require('express');
const User = require('../models/User');
const Party = require('../models/Party');
const { resolveBusinessOwner, isTenantAdmin } = require('../utils/access');

const router = express.Router();

const normalizeUser = (user) => user.toJSON();

const findAdminParty = async (adminId, partyId, businessOwnerId) => {
  if (!partyId) return null;
  return Party.findOne({ _id: partyId, userId: adminId, businessOwnerId });
};

router.get('/', async (req, res) => {
  try {
    if (!isTenantAdmin(req.user)) {
      return res.status(403).json({ message: 'Business admin access required' });
    }

    const users = await User.find({
      _id: { $ne: req.user._id },
      $or: [
        {
          status: 'pending',
          role: 'party',
          pendingForAdminId: req.user._id,
        },
        { ownerId: req.user._id },
      ],
    }).sort({ createdAt: -1 });

    res.json(users.map(normalizeUser));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching users', error: error.message });
  }
});

router.get('/pending-parties', async (req, res) => {
  try {
    if (!isTenantAdmin(req.user)) {
      return res.status(403).json({ message: 'Business admin access required' });
    }

    const users = await User.find({
      status: 'pending',
      role: 'party',
      pendingForAdminId: req.user._id,
    }).sort({ createdAt: -1 });
    res.json(users.map(normalizeUser));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching pending parties', error: error.message });
  }
});

router.get('/pending', async (req, res) => {
  try {
    if (!isTenantAdmin(req.user)) {
      return res.status(403).json({ message: 'Business admin access required' });
    }

    const users = await User.find({
      status: 'pending',
      role: 'party',
      pendingForAdminId: req.user._id,
    }).sort({ createdAt: -1 });
    res.json(users.map(normalizeUser));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching pending users', error: error.message });
  }
});

router.patch('/:id/approve', resolveBusinessOwner, async (req, res) => {
  try {
    if (!isTenantAdmin(req.user)) {
      return res.status(403).json({ message: 'Business admin access required' });
    }

    const { partyId = '' } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot approve your own account here' });
    }

    if (user.role !== 'party' || user.status !== 'pending') {
      return res.status(400).json({ message: 'This action only applies to pending party users' });
    }

    if (String(user.pendingForAdminId) !== String(req.user._id)) {
      return res.status(403).json({ message: 'You can only approve users who requested your organization' });
    }

    const linkedParty = await findAdminParty(req.user._id, partyId || user.partyId, req.businessOwnerId);
    if (!linkedParty) {
      return res.status(400).json({ message: 'Select a valid party for this user' });
    }

    user.role = 'party';
    user.status = 'approved';
    user.ownerId = req.user._id;
    user.partyId = String(linkedParty._id);
    user.partyName = linkedParty.name;
    user.businessOwnerId = req.businessOwnerId;
    user.pendingForAdminId = null;
    user.approvedBy = req.user._id;
    user.approvedAt = new Date();
    user.rejectedAt = null;
    user.disabledAt = null;
    await user.save({ validateBeforeSave: false });

    res.json(normalizeUser(user));
  } catch (error) {
    res.status(400).json({ message: 'Error approving user', error: error.message });
  }
});

router.patch('/:id/reject', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot reject your own account' });
    }

    if (user.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending accounts can be rejected here' });
    }

    if (
      !isTenantAdmin(req.user)
      || user.role !== 'party'
      || String(user.pendingForAdminId) !== String(req.user._id)
    ) {
      return res.status(403).json({ message: 'You cannot reject this user' });
    }

    user.status = 'rejected';
    user.rejectedAt = new Date();
    user.disabledAt = null;
    await user.save({ validateBeforeSave: false });

    res.json(normalizeUser(user));
  } catch (error) {
    res.status(400).json({ message: 'Error rejecting user', error: error.message });
  }
});

router.patch('/:id/disable', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot disable your own account' });
    }

    if (!isTenantAdmin(req.user)) {
      return res.status(403).json({ message: 'Business admin access required' });
    }

    if (user.role !== 'party' || String(user.ownerId) !== String(req.user._id) || user.status !== 'approved') {
      return res.status(400).json({ message: 'You can only disable approved party users in your organization' });
    }

    user.status = 'disabled';
    user.disabledAt = new Date();
    await user.save({ validateBeforeSave: false });

    res.json(normalizeUser(user));
  } catch (error) {
    res.status(400).json({ message: 'Error disabling user', error: error.message });
  }
});

module.exports = router;
