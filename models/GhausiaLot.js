const mongoose = require("mongoose");

const ghausiaLotSchema = new mongoose.Schema(
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
    lotNo: {
      type: String,
      trim: true,
      default: "",
      required: false,
    },
    designNo: {
      type: String,
      trim: true,
      default: "",
      required: false,
    },
    description: {
      type: String,
      trim: true,
      default: "",
      required: false,
    },
    fabric: {
      type: String,
      trim: true,
      default: "",
      required: false,
    },
    customFabric: {
      type: String,
      trim: true,
      default: "",
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
      default: "",
      required: false,
    },
    partyName: {
      type: String,
      default: "Unknown",
      required: false,
    },
    lotNumber: {
      type: String,
      trim: true,
      default: "",
      required: false,
    },
    itemType: {
      type: String,
      trim: true,
      default: "",
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
      default: "pieces",
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
        "pending",
        "dispatched",
        "received back",
        "completed",
        "in progress",
        "pending approval",
        "rejected",
        "Pending",
        "Dispatched",
        "Received Back",
        "Completed",
        "In Progress",
        "Pending Approval",
        "Rejected",
        "processing",
      ],
      default: "pending",
      required: false,
    },
    notes: {
      type: String,
      default: "",
      required: false,
    },
    rejectionNote: {
      type: String,
      default: "",
      required: false,
    },
    suitType: {
      type: String,
      enum: ["2-piece", "3-piece", "dupatta-only"],
      default: "2-piece",
      required: false,
    },
    suitComponent: {
      type: String,
      enum: ["main", "dupatta"],
      default: "main",
      required: false,
    },
    ownerBillingChoice: {
      type: String,
      enum: ["separate", "combined"],
      default: "separate",
      required: false,
    },
    isRework: {
      type: Boolean,
      default: false,
      required: false,
    },
    linkedLotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GhausiaLot",
      required: false,
    },
  },
  {
    timestamps: true,
  },
);

// Lot numbers are unique per (user × business workspace), not globally on lotNumber.
// We include suitComponent and isRework to allow identical lot numbers for Dupatta and Rework cases.
ghausiaLotSchema.index(
  { userId: 1, businessOwnerId: 1, lotNumber: 1, suitComponent: 1, isRework: 1 },
  {
    unique: true,
    name: "userId_1_businessOwnerId_1_lotNumber_1_suitComponent_1_isRework_1_unique",
    partialFilterExpression: {
      lotNumber: { $exists: true, $type: "string", $gt: "" },
    },
  },
);
ghausiaLotSchema.index({ userId: 1, businessOwnerId: 1, receivedDate: -1 });
ghausiaLotSchema.index({ userId: 1, partyId: 1 });
ghausiaLotSchema.index({ userId: 1, receivedDate: -1 });
ghausiaLotSchema.index({
  userId: 1,
  businessOwnerId: 1,
  status: 1,
  receivedDate: -1,
});

module.exports = mongoose.model("GhausiaLot", ghausiaLotSchema);

// Auto-drop the old index so we can create 3-piece duplicate lot numbers.
mongoose.connection.once('open', async () => {
  try {
    const col = mongoose.connection.collection("ghausialots");
    await col.dropIndex("userId_1_businessOwnerId_1_lotNumber_1_partial_unique");
    console.log("Old partial index dropped successfully.");
  } catch (e) {}
});
