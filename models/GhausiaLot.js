const mongoose = require('mongoose');

const ghausiaLotSchema = new mongoose.Schema({
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
  lotNo: {
    type: String,
    trim: true,
    default: '',
    required: false,
  },
  designNo: {
    type: String,
    trim: true,
    default: '',
    required: false,
  },
  description: {
    type: String,
    trim: true,
    default: '',
    required: false,
  },
  fabric: {
    type: String,
    trim: true,
    default: '',
    required: false,
  },
  customFabric: {
    type: String,
    trim: true,
    default: '',
    required: false,
  },
  colors: {
    type: Number,
    default: 0,
    required: false,
  },
  pieces: {
    type: Number,
    default: 0,
    required: false,
  },
  allotDate: {
    type: Date,
    default: Date.now,
    required: false,
  },
  partyId: {
    type: String,
    default: '',
    required: false,
  },
  partyName: {
    type: String,
    default: 'Unknown',
    required: false,
  },
  lotNumber: {
    type: String,
    trim: true,
    default: '',
    required: false,
  },
  itemType: {
    type: String,
    trim: true,
    default: '',
    required: false,
  },
  quantity: {
    type: Number,
    default: 0,
    min: 0,
    required: false,
  },
  unit: {
    type: String,
    default: 'pieces',
    required: false,
  },
  rate: {
    type: Number,
    default: 0,
    min: 0,
    required: false,
  },
  billAmount: {
    type: Number,
    default: 0,
    min: 0,
    required: false,
  },
  totalAmount: {
    type: Number,
    default: 0,
    required: false,
  },
  receivedDate: {
    type: Date,
    default: Date.now,
    required: false,
  },
  dispatchDate: {
    type: Date,
    default: null,
    required: false,
  },
  receivedBackDate: {
    type: Date,
    default: null,
    required: false,
  },
  /** Set when admin approves completion (pending approval → received back) or when marking billable/completed without prior timestamp */
  completionApprovedAt: {
    type: Date,
    default: null,
    required: false,
  },
  /** When the party submitted this lot for admin review (pending approval). */
  pendingReviewSubmittedAt: {
    type: Date,
    default: null,
    required: false,
  },
  status: {
    type: String,
    enum: [
      'pending', 'dispatched', 'received back', 'completed', 'in progress',
      'pending approval', 'rejected',
      'Pending', 'Dispatched', 'Received Back', 'Completed', 'In Progress',
      'Pending Approval', 'Rejected',
      'processing',
    ],
    default: 'pending',
    required: false,
  },
  notes: {
    type: String,
    default: '',
    required: false,
  },
  rejectionNote: {
    type: String,
    default: '',
    required: false,
  },
}, {
  timestamps: true,
});

// Lot numbers are unique per (user × business workspace), not globally on lotNumber.
// Legacy databases may still have `{ lotNumber: 1 }, { unique: true }` — run:
// `npm run migrate:lot-indexes` to drop it and sync this compound index.
ghausiaLotSchema.index(
  { userId: 1, businessOwnerId: 1, lotNumber: 1 },
  {
    unique: true,
    name: 'userId_1_businessOwnerId_1_lotNumber_1_partial_unique',
    partialFilterExpression: { lotNumber: { $exists: true, $type: 'string', $gt: '' } },
  },
);
ghausiaLotSchema.index({ userId: 1, businessOwnerId: 1, receivedDate: -1 });
ghausiaLotSchema.index({ userId: 1, partyId: 1 });
ghausiaLotSchema.index({ userId: 1, receivedDate: -1 });
ghausiaLotSchema.index({ userId: 1, businessOwnerId: 1, status: 1, receivedDate: -1 });

module.exports = mongoose.model('GhausiaLot', ghausiaLotSchema);
