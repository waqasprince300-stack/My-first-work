const mongoose = require("mongoose");
const { parseDateValue } = require("../utils/dateHelpers");

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
      enum: ["Received", "Paid", "Tally"],
      required: true,
      default: "Received",
    },
    amount: {
      type: Number,
      required: true,
      validate: {
        async validator(val) {
          if (typeof val !== "number" || !Number.isFinite(val)) return false;
          if (val < -100000000 || val > 100000000) return false;
          const updateObj =
            typeof this.getUpdate === "function" ? this.getUpdate() : null;
          const queryObj =
            typeof this.getQuery === "function" ? this.getQuery() : null;
          let docType =
            this.type ??
            updateObj?.$set?.type ??
            updateObj?.type ??
            queryObj?.type;
          if (!docType && queryObj && typeof this.model?.findOne === "function") {
            if (this.op === "updateMany") {
              const hasNonTally = await this.model.exists({
                ...queryObj,
                type: { $ne: "Tally" },
              });
              if (!hasNonTally) docType = "Tally";
            } else {
              const existing = await this.model
                .findOne(queryObj)
                .select("type")
                .lean();
              docType = existing?.type;
            }
          }
          if (docType === "Tally") return true;
          return val >= 0;
        },
        message:
          "Amount must be between 0 and 100,000,000 (or within [-100M, 100M] for Tally markers)",
      },
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
    ownerBillId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OwnerBill",
      default: null,
    },
    billedInBillNo: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    billedInBookNo: {
      type: Number,
      default: null,
    },
    isBillManualCash: {
      type: Boolean,
      default: false,
    },
    isLegacySettled: {
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
    const parsed = parseDateValue(doc.date);
    if (parsed && !Number.isNaN(parsed.getTime())) {
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
      const parsed = parseDateValue(newDate);
      if (parsed && !Number.isNaN(parsed.getTime())) {
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
