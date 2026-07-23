const mongoose = require("mongoose");

const savedDesignSchema = new mongoose.Schema(
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
    designNumber: {
      type: String,
      required: true,
      trim: true,
    },
    rows: [
      {
        part: { type: String, default: "" },
        label: { type: String, default: "" },
        baseStitches: { type: String, default: "" },
        repeat: { type: Number, default: 1 },
      },
    ],
    rate: {
      type: String,
      default: "",
    },
    pieces: {
      type: Number,
      default: 1,
    },
    grandTotal: {
      type: Number,
      default: 0,
    },
    onePieceRate: {
      type: Number,
      default: 0,
    },
    totalCost: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("SavedDesign", savedDesignSchema);
