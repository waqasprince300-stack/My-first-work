const mongoose = require('mongoose');

const dashboardSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  date: {
    type: Date,
    default: Date.now,
  },
  totalCollections: {
    type: Number,
    default: 0,
  },
  totalParties: {
    type: Number,
    default: 0,
  },
  totalPayments: {
    type: Number,
    default: 0,
  },
  pendingPayments: {
    type: Number,
    default: 0,
  },
  monthlyRevenue: {
    type: Number,
    default: 0,
  },
  yearlyRevenue: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Dashboard', dashboardSchema);
