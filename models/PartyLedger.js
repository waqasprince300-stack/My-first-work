const mongoose = require("mongoose");

const partyLedgerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    businessOwnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessOwner",
      required: true,
      index: true,
    },
    lotId: {
      type: String,
      default: "",
    },
    lotNumber: {
      type: String,
      trim: true,
      default: "",
    },
    designNo: {
      type: String,
      trim: true,
      default: "",
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    itemType: {
      type: String,
      trim: true,
      default: "",
    },
    colors: {
      type: Number,
      default: 0,
    },
    quantity: {
      type: Number,
      default: 0,
    },
    pieces: {
      type: Number,
      default: 0,
    },
    allotDate: {
      type: Date,
      default: Date.now,
    },
    completeDate: {
      type: Date,
      default: null,
    },
    partyId: {
      type: String,
      default: "",
    },
    partyName: {
      type: String,
      trim: true,
      default: "Unknown",
    },
    status: {
      type: String,
      trim: true,
      default: "pending",
    },
    billAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    receipt: {
      type: String,
      trim: true,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

partyLedgerSchema.index({ userId: 1, businessOwnerId: 1, partyId: 1 });
partyLedgerSchema.index({ userId: 1, businessOwnerId: 1, lotId: 1 });
partyLedgerSchema.index({ userId: 1, businessOwnerId: 1, completeDate: -1 });

module.exports = mongoose.model("PartyLedger", partyLedgerSchema);
