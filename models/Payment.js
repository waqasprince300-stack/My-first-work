const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
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
    type: {
      type: String,
      enum: ["Received", "Paid"],
      required: true,
      default: "Received",
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
      max: [100000000, "Amount cannot exceed 100,000,000"],
    },
    party: {
      type: String,
      default: "",
    },
    partyId: {
      type: String,
      default: "",
    },
    date: {
      type: String,
      default: "",
    },
    dateObj: {
      type: Date,
      required: false,
      index: true,
    },
    note: {
      type: String,
      default: "",
    },
    linkedLot: {
      type: String,
      default: "",
    },
    /** Optional payment slip image/pdf stored as a base64 data URL (excluded from list payloads for size). */
    receipt: {
      type: String,
      default: "",
    },
    /** Lightweight presence flag so list/bootstrap payloads can show a slip thumbnail without shipping the blob. */
    hasReceipt: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

function syncDateObj(doc) {
  if (doc && typeof doc.date === "string" && doc.date.trim()) {
    const parsed = new Date(doc.date);
    if (!Number.isNaN(parsed.getTime())) {
      doc.dateObj = parsed;
    }
  }
}

paymentSchema.pre("save", function (next) {
  syncDateObj(this);
  next();
});

paymentSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate();
  if (update && (update.date || update.$set?.date)) {
    const newDate = update.date || update.$set.date;
    if (typeof newDate === "string" && newDate.trim()) {
      const parsed = new Date(newDate);
      if (!Number.isNaN(parsed.getTime())) {
        if (!update.$set) update.$set = {};
        update.$set.dateObj = parsed;
      }
    }
  }
  next();
});

paymentSchema.index({ userId: 1, businessOwnerId: 1, createdAt: -1 });
paymentSchema.index({ userId: 1, businessOwnerId: 1, partyId: 1 });
paymentSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", paymentSchema);
