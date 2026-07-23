const mongoose = require("mongoose");

const collectionSchema = new mongoose.Schema(
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
    partyName: {
      type: String,
      required: true,
      trim: true,
    },
    itemType: {
      type: String,
      required: true,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    unit: {
      type: String,
      default: "meters",
    },
    rate: {
      type: Number,
      required: true,
      min: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "cancelled"],
      default: "pending",
    },
    description: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

collectionSchema.index({ userId: 1, businessOwnerId: 1, date: -1 });

module.exports = mongoose.model("Collection", collectionSchema);
