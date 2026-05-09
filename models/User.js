const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: true,
    minlength: 8,
    select: false,
  },
  role: {
    type: String,
    enum: ['admin', 'party'],
    default: 'party',
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'disabled'],
    default: 'pending',
    index: true,
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  pendingForAdminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  partyId: {
    type: String,
    default: '',
  },
  partyName: {
    type: String,
    default: '',
  },
  businessOwnerId: {
    type: String,
    default: '',
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
}, {
  timestamps: true,
});

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) {
    return next();
  }

  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.createPasswordResetToken = function createPasswordResetToken() {
  const resetToken = crypto.randomBytes(32).toString('hex');

  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  const expiryMinutes = Number(process.env.PASSWORD_RESET_TOKEN_EXPIRES_MINUTES) || 10;
  this.passwordResetExpires = Date.now() + expiryMinutes * 60 * 1000;

  return resetToken;
};

userSchema.methods.toJSON = function toJSON() {
  const user = this.toObject();
  delete user.password;
  delete user.passwordResetToken;
  delete user.passwordResetExpires;
  return user;
};

module.exports = mongoose.model('User', userSchema);
