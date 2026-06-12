const mongoose = require('mongoose');

/**
 * One-time passwords for new-device login verification and password reset.
 * Codes are stored only as a SHA-256 hash. Documents auto-expire via a TTL index.
 */
const otpSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  purpose: {
    type: String,
    enum: ['login_device', 'password_reset'],
    required: true,
    index: true,
  },
  channel: {
    type: String,
    enum: ['email', 'sms'],
    required: true,
  },
  /** Raw destination (email/phone) the code was sent to — never returned to clients. */
  destination: {
    type: String,
    default: '',
    select: false,
  },
  codeHash: {
    type: String,
    required: true,
    select: false,
  },
  /** Device the login OTP unlocks (for purpose: login_device). */
  deviceId: {
    type: String,
    default: '',
  },
  attempts: {
    type: Number,
    default: 0,
  },
  resendCount: {
    type: Number,
    default: 0,
  },
  consumed: {
    type: Boolean,
    default: false,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
}, {
  timestamps: true,
});

// TTL: Mongo removes the doc once expiresAt passes.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ userId: 1, purpose: 1, consumed: 1 });

module.exports = mongoose.model('Otp', otpSchema);
