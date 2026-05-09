const mongoose = require('mongoose');

const ghausiaLotSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
  status: {
    type: String,
    enum: ['pending', 'dispatched', 'received back', 'completed', 'in progress', 'Pending', 'Dispatched', 'Received Back', 'Completed', 'In Progress', 'processing'],
    default: 'pending',
    required: false,
  },
  notes: {
    type: String,
    default: '',
    required: false,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('GhausiaLot', ghausiaLotSchema);
