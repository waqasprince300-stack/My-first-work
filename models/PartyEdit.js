const mongoose = require('mongoose');

const partyEditSchema = new mongoose.Schema({
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
  lotId: {
    type: String,
    required: true,
  },
  completeDate: {
    type: Date,
    default: null,
  },
  partyBillAmount: {
    type: Number,
    default: 0,
  },
  receipt: {
    type: String,
    default: null,
  },
  notes: {
    type: String,
    default: '',
  },
  overrideStatus: {
    type: String,
    default: '',
  },
  /** Optional audit blob when admin changes a completed lot amount */
  amountChangeNote: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  /** When party revises bill while awaiting admin approval — drives owner billing options on approve */
  pendingRevision: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  allotDate: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('PartyEdit', partyEditSchema);
