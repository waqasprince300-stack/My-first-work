const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
      unique: true,
    },
    phone: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    role: {
      type: String,
      enum: ["super_admin", "admin", "party", "personal_khata"],
      default: "party",
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "disabled"],
      default: "pending",
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    pendingForAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    partyId: {
      type: String,
      default: "",
    },
    partyName: {
      type: String,
      default: "",
    },
    businessOwnerId: {
      type: String,
      default: "",
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    disabledAt: {
      type: Date,
      default: null,
    },
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
    /** Devices that have passed new-device OTP verification (skip OTP on future logins). */
    knownDevices: {
      type: [
        {
          deviceId: { type: String, required: true },
          label: { type: String, default: "" },
          createdAt: { type: Date, default: Date.now },
          lastSeenAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

userSchema.pre("validate", function requireIdentity(next) {
  const hasEmail = Boolean(this.email && String(this.email).trim());
  const hasPhone = Boolean(this.phone && String(this.phone).trim());

  if (this.role === "personal_khata") {
    if (!hasEmail && !hasPhone) {
      this.invalidate(
        "email",
        "Email or phone is required for Personal Khata accounts",
      );
    }
  } else if (!hasEmail) {
    this.invalidate("email", "Email is required");
  }

  next();
});

userSchema.pre("save", async function hashPassword(next) {
  if (!this.isModified("password")) {
    return next();
  }

  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function comparePassword(
  candidatePassword,
) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.createPasswordResetToken =
  function createPasswordResetToken() {
    const resetToken = crypto.randomBytes(32).toString("hex");

    this.passwordResetToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    const expiryMinutes =
      Number(process.env.PASSWORD_RESET_TOKEN_EXPIRES_MINUTES) || 10;
    this.passwordResetExpires = Date.now() + expiryMinutes * 60 * 1000;

    return resetToken;
  };

userSchema.methods.hasKnownDevice = function hasKnownDevice(deviceId) {
  const id = String(deviceId || "").trim();
  if (!id) return false;
  return (this.knownDevices || []).some((d) => String(d.deviceId) === id);
};

userSchema.methods.rememberDevice = function rememberDevice(
  deviceId,
  label = "",
) {
  const id = String(deviceId || "").trim();
  if (!id) return;
  if (!Array.isArray(this.knownDevices)) this.knownDevices = [];
  const existing = this.knownDevices.find((d) => String(d.deviceId) === id);
  if (existing) {
    existing.lastSeenAt = new Date();
    if (label) existing.label = label;
  } else {
    this.knownDevices.push({
      deviceId: id,
      label,
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
  }
};

userSchema.methods.toJSON = function toJSON() {
  const user = this.toObject();
  delete user.password;
  delete user.passwordResetToken;
  delete user.passwordResetExpires;
  delete user.knownDevices;
  return user;
};

module.exports = mongoose.model("User", userSchema);
