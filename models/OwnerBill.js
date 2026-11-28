const mongoose = require("mongoose");

const billLotItemSchema = new mongoose.Schema(
  {
    lotId: { type: String, default: "" },
    lotNo: { type: String, default: "" },
    designNo: { type: String, default: "" },
    suitComponent: { type: String, default: "main" },
    isRework: { type: Boolean, default: false },
    quantity: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    preBillRate: { type: Number, default: null },
    preBillAmount: { type: Number, default: null },
    note: { type: String, default: "" },
  },
  { _id: false },
);

const unpaidPreviousBillSchema = new mongoose.Schema(
  {
    billNo: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    note: { type: String, default: "" },
  },
  { _id: false },
);

const billPaymentReceivedSchema = new mongoose.Schema(
  {
    paymentId: { type: String, default: "" },
    date: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    note: { type: String, default: "" },
  },
  { _id: false },
);

const billDeductionSchema = new mongoose.Schema(
  {
    title: { type: String, default: "" },
    amount: { type: Number, default: 0 },
  },
  { _id: false },
);

const ownerBillSchema = new mongoose.Schema(
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
    bookNo: {
      type: Number,
      default: 1,
      min: 1,
    },
    billNo: {
      type: Number,
      required: true,
      min: 1,
    },
    date: {
      type: String, // YYYY-MM-DD
      required: true,
    },
    ownerName: {
      type: String,
      default: "",
    },
    // Array of lot items included in this bill
    lots: [billLotItemSchema],
    currentBillTotal: {
      type: Number,
      default: 0,
    },
    // Unsettled previous bills included (e.g. Bill #71 = ₨1,642,416)
    unpaidPreviousBills: [unpaidPreviousBillSchema],
    unpaidPreviousBillsTotal: {
      type: Number,
      default: 0,
    },
    // Sabqa Baqaya brought forward from last bill
    sabqaBaqaya: {
      type: Number,
      default: 0,
    },
    grossTotal: {
      type: Number,
      default: 0,
    },
    // Online or cash payments received
    paymentsReceived: [billPaymentReceivedSchema],
    totalPaymentsReceived: {
      type: Number,
      default: 0,
    },
    subTotalAfterPayments: {
      type: Number,
      default: 0,
    },
    // Deductions / Katotiyan (Dhaga, Kapra cut, Discount, etc.)
    deductions: [billDeductionSchema],
    totalDeductions: {
      type: Number,
      default: 0,
    },
    // Final Grand Total Baqaya remaining
    grandTotalBaqaya: {
      type: Number,
      required: true,
      default: 0,
    },
    status: {
      type: String,
      enum: ["draft", "finalized"],
      default: "finalized",
    },
    notes: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

ownerBillSchema.index(
  { userId: 1, businessOwnerId: 1, bookNo: 1, billNo: 1 },
  { unique: true }
);

module.exports = mongoose.model("OwnerBill", ownerBillSchema);
