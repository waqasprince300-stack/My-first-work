const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "lot_rejected",
        "lot_pending_review",
        "bill_revision_request",
        "bill_revision_approved",
        "bill_revision_rejected",
        "payment_recorded",
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      default: "",
      trim: true,
    },
    lotId: {
      type: String,
      default: "",
      index: true,
    },
    lotNumber: {
      type: String,
      default: "",
    },
    businessOwnerId: {
      type: String,
      default: "",
    },
    linkPath: {
      type: String,
      default: "",
    },
    readAt: {
      type: Date,
      default: null,
    },
    emailSentAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index({ userId: 1, type: 1, lotId: 1, readAt: 1 });

module.exports = mongoose.model("Notification", notificationSchema);
