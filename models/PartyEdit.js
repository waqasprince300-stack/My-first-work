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
  /** Lot pictures added by party and/or admin, stored as base64 data URLs (excluded from list payloads for size). */
  lotImages: {
    type: [String],
    default: [],
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
  /** Party-initiated bill-change request on an already approved/completed lot — admin approves to apply */
  billRevisionRequest: {
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

partyEditSchema.index({ userId: 1, businessOwnerId: 1, lotId: 1 });
partyEditSchema.index({ userId: 1, lotId: 1 });
partyEditSchema.index({ userId: 1, businessOwnerId: 1, createdAt: -1 });
partyEditSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('PartyEdit', partyEditSchema);
