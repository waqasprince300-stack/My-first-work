const express = require('express');
const router = express.Router();
const Payment = require('../models/Payment');

const normalize = (doc) => ({ ...doc.toObject(), id: doc._id.toString() });
const getUserId = (req) => req.user._id;
const stripOwnership = ({ userId, ...data }) => data;

// Get all payments
router.get('/', async (req, res) => {
  try {
    const payments = await Payment.find({ userId: getUserId(req) }).sort({ createdAt: -1 });
    res.json(payments.map(normalize));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching payments', error: error.message });
  }
});

// Get single payment
router.get('/:id', async (req, res) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, userId: getUserId(req) });
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    res.json(normalize(payment));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching payment', error: error.message });
  }
});

// Create payment
router.post('/', async (req, res) => {
  try {
    const payment = new Payment({ ...stripOwnership(req.body), userId: getUserId(req) });
    const saved = await payment.save();
    res.status(201).json(normalize(saved));
  } catch (error) {
    res.status(400).json({ message: 'Error creating payment', error: error.message });
  }
});

// Update payment
router.patch('/:id', async (req, res) => {
  try {
    const payment = await Payment.findOneAndUpdate(
      { _id: req.params.id, userId: getUserId(req) },
      stripOwnership(req.body),
      { new: true, runValidators: true }
    );
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    res.json(normalize(payment));
  } catch (error) {
    res.status(400).json({ message: 'Error updating payment', error: error.message });
  }
});

// Delete payment
router.delete('/:id', async (req, res) => {
  try {
    const payment = await Payment.findOneAndDelete({ _id: req.params.id, userId: getUserId(req) });
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    res.json({ message: 'Payment deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting payment', error: error.message });
  }
});

module.exports = router;
