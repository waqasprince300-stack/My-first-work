const mongoose = require("mongoose");

const announcementSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
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
    severity: {
      type: String,
      enum: ["info", "warning", "urgent", "success"],
      default: "info",
    },
    targetPartyId: {
      type: String, // 'all' or specific party ID
      default: "all",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    expiresAt: {
      type: Date,
      default: null,
      index: { expires: '1m', partialFilterExpression: { expiresAt: { $exists: true, $ne: null } } }
    },
  },
  { timestamps: true },
);

announcementSchema.index({ ownerId: 1, isActive: 1 });

module.exports = mongoose.model("Announcement", announcementSchema);
