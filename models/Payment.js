const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  businessOwnerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BusinessOwner',
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['Received', 'Paid'],
    required: true,
    default: 'Received',
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  party: {
    type: String,
    default: '',
  },
  partyId: {
    type: String,
    default: '',
  },
  date: {
    type: String,
    default: '',
  },
  note: {
    type: String,
    default: '',
  },
  linkedLot: {
    type: String,
    default: '',
  },
}, {
  timestamps: true,
});

paymentSchema.index({ userId: 1, businessOwnerId: 1, createdAt: -1 });
paymentSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);
