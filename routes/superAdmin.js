const express = require('express');
const User = require('../models/User');

const router = express.Router();

router.get('/pending-admins', async (req, res) => {
  try {
    const admins = await User.find({
      role: 'admin',
      status: 'pending',
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json(admins);
  } catch (error) {
    res.status(500).json({ message: 'Error loading pending administrators', error: error.message });
  }
});

router.patch('/admins/:id/approve', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot approve your own account here' });
    }

    if (user.role !== 'admin' || user.status !== 'pending') {
      return res.status(400).json({ message: 'This action only applies to pending organization administrators' });
    }

    user.status = 'approved';
    user.ownerId = user._id;
    user.approvedBy = req.user._id;
    user.approvedAt = new Date();
    user.rejectedAt = null;
    user.disabledAt = null;
    user.pendingForAdminId = null;
    await user.save({ validateBeforeSave: false });

    res.json(user.toJSON());
  } catch (error) {
    res.status(400).json({ message: 'Error approving administrator', error: error.message });
  }
});

router.patch('/admins/:id/reject', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot reject your own account' });
    }

    if (user.role !== 'admin' || user.status !== 'pending') {
      return res.status(400).json({ message: 'This action only applies to pending organization administrators' });
    }

    user.status = 'rejected';
    user.rejectedAt = new Date();
    user.disabledAt = null;
    await user.save({ validateBeforeSave: false });

    res.json(user.toJSON());
  } catch (error) {
    res.status(400).json({ message: 'Error rejecting administrator', error: error.message });
  }
});

module.exports = router;
