const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const authenticate = require('../middleware/auth');
const { getMailConfigError, sendPasswordResetEmail } = require('../utils/email');
const { getRegistrationEmailError } = require('../utils/registrationEmail');

const router = express.Router();

const getJwtSecret = () => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required');
  }

  return 'development-jwt-secret-change-me';
};

const signToken = (userId) => {
  return jwt.sign(
    { id: userId },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

const sendAuthResponse = (res, statusCode, user, extra = {}) => {
  const token = signToken(user._id);

  res.status(statusCode).json({
    token,
    user,
    ...extra,
  });
};

const normalizeSignupRole = (role) => {
  const r = String(role || 'party').toLowerCase();
  return r === 'admin' ? 'admin' : 'party';
};

const sanitizeUserInput = ({ name, email, password, role, partyId, partyName, adminEmail }) => ({
  name: name && name.trim(),
  email: email && email.trim().toLowerCase(),
  password,
  role: normalizeSignupRole(role),
  partyId: partyId ? String(partyId).trim() : '',
  partyName: partyName ? String(partyName).trim() : '',
  adminEmail: adminEmail ? String(adminEmail).trim().toLowerCase() : '',
});

const getFrontendUrl = () => {
  return (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
};

router.post('/signup', async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role: requestedRole,
      partyId,
      partyName,
      adminEmail,
    } = sanitizeUserInput(req.body);

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const emailErr = getRegistrationEmailError(email);
    if (emailErr) {
      return res.status(400).json({ message: emailErr });
    }

    if (adminEmail) {
      const adminEmailErr = getRegistrationEmailError(adminEmail);
      if (adminEmailErr) {
        return res.status(400).json({ message: `Business administrator email: ${adminEmailErr}` });
      }
    }

    const approvedAdminCount = await User.countDocuments({
      role: 'admin',
      status: 'approved',
    });

    if (requestedRole === 'admin') {
      if (approvedAdminCount > 0) {
        return res.status(409).json({
          message:
            'An organization administrator is already registered. New accounts must be party users — enter your administrator\'s email when signing up.',
        });
      }

      const user = await User.create({
        name,
        email,
        password,
        role: 'admin',
        status: 'approved',
        partyId: '',
        partyName: '',
      });

      user.ownerId = user._id;
      user.approvedBy = user._id;
      user.approvedAt = new Date();
      await user.save({ validateBeforeSave: false });
      return sendAuthResponse(res, 201, user, {
        message: 'Organization administrator account created. You are now signed in.',
      });
    }

    if (approvedAdminCount === 0) {
      return res.status(400).json({
        message:
          'No organization administrator exists yet. The first person must register as the organization administrator before party users can sign up.',
      });
    }

    // Party user — must target an approved business admin
    if (!adminEmail) {
      return res.status(400).json({
        message: 'Provide the email of the business administrator you are requesting to join.',
      });
    }

    const targetAdmin = await User.findOne({
      email: adminEmail,
      role: 'admin',
      status: 'approved',
    });

    if (!targetAdmin) {
      return res.status(400).json({
        message: 'No approved business administrator was found for that email. Check the address or try again after your org has an approved admin.',
      });
    }

    const user = await User.create({
      name,
      email,
      password,
      role: 'party',
      status: 'pending',
      partyId,
      partyName,
      pendingForAdminId: targetAdmin._id,
    });

    res.status(201).json({
      message: 'Account created and waiting for your business administrator to approve',
      user,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Email is already registered' });
    }

    res.status(400).json({ message: 'Error creating user', error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = req.body.email && req.body.email.trim().toLowerCase();
    const { password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.role === 'super_admin') {
      await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
      user.role = 'admin';
    }

    if (user.status !== 'approved') {
      const messages = {
        pending: 'Your account is waiting for business administrator approval',
        rejected: 'Your account request was rejected',
        disabled: 'Your account has been disabled',
      };

      return res.status(403).json({ message: messages[user.status] || 'Account is not approved' });
    }

    sendAuthResponse(res, 200, user);
  } catch (error) {
    res.status(500).json({ message: 'Error logging in', error: error.message });
  }
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

router.post('/forgot-password', async (req, res) => {
  try {
    const email = req.body.email && req.body.email.trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await User.findOne({ email }).select('+passwordResetToken +passwordResetExpires');

    if (!user) {
      return res.json({ message: 'If that email exists, a reset link has been generated' });
    }

    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${getFrontendUrl()}/reset-password/${resetToken}`;
    const mailConfigError = getMailConfigError();

    if (mailConfigError && process.env.NODE_ENV !== 'production') {
      return res.json({
        message: 'Email is not configured. Use this development reset link instead.',
        resetUrl,
        emailWarning: mailConfigError.message,
      });
    }

    try {
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl,
      });
    } catch (emailError) {
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: false });

      return res.status(500).json({
        message: 'Unable to send password reset email. Please check email configuration.',
        error: emailError.message,
      });
    }

    const response = {
      message: 'If that email exists, a reset link has been sent',
    };

    if (process.env.NODE_ENV !== 'production') {
      response.resetUrl = resetUrl;
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ message: 'Error generating password reset token', error: error.message });
  }
});

router.patch('/reset-password/:token', async (req, res) => {
  try {
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const hashedToken = crypto
      .createHash('sha256')
      .update(req.params.token)
      .digest('hex');

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select('+passwordResetToken +passwordResetExpires +password');

    if (!user) {
      return res.status(400).json({ message: 'Password reset token is invalid or has expired' });
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    if (user.status !== 'approved') {
      return res.json({ message: 'Password reset successfully. You can login after admin approval.', user });
    }

    sendAuthResponse(res, 200, user);
  } catch (error) {
    res.status(500).json({ message: 'Error resetting password', error: error.message });
  }
});

module.exports = router;
