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
  allotDate: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('PartyEdit', partyEditSchema);
