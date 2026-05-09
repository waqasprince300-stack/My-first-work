const mongoose = require('mongoose');

const partySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  contactPerson: {
    type: String,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
  },
  address: {
    type: String,
    trim: true,
  },
  city: {
    type: String,
    trim: true,
  },
  businessType: {
    type: String,
    default: 'Regular',
  },
  openingBalance: {
    type: Number,
    default: 0,
  },
  totalDue: {
    type: Number,
    default: 0,
  },
  totalPaid: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
  },
  notes: {
    type: String,
    default: '',
  },
}, {
  timestamps: true,
});

partySchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Party', partySchema);
