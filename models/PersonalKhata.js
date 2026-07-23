const mongoose = require("mongoose");

const personalKhataSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    businesses: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    activeBusinessId: {
      type: String,
      default: "",
    },
    contacts: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    entries: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("PersonalKhata", personalKhataSchema);
