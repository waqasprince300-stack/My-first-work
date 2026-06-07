const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const authenticate = require('../middleware/auth');
const { getMailConfigError, sendPasswordResetEmail } = require('../utils/email');
const { getRegistrationEmailError } = require('../utils/registrationEmail');
const { normalizePhone, validatePhone } = require('../utils/phone');

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
  if (r === 'admin') return 'admin';
  if (r === 'personal_khata') return 'personal_khata';
  return 'party';
};

const sanitizeUserInput = ({
  name,
  email,
  phone,
  password,
  role,
  partyId,
  partyName,
  adminEmail,
}) => ({
  name: name && name.trim(),
  email: email ? String(email).trim().toLowerCase() : '',
  phone: normalizePhone(phone),
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

const duplicateIdentityMessage = (error) => {
  if (error.code !== 11000) return null;
  const key = Object.keys(error.keyPattern || error.keyValue || {})[0] || '';
  if (key.includes('email')) return 'Email is already registered';
  if (key.includes('phone')) return 'Phone number is already registered';
  return 'Account already exists';
};

router.post('/signup', async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      role: requestedRole,
      partyId,
      partyName,
      adminEmail,
    } = sanitizeUserInput(req.body);

    if (!name || !password) {
      return res.status(400).json({ message: 'Name and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    if (requestedRole === 'personal_khata') {
      if (!email && !phone) {
        return res.status(400).json({ message: 'Email or phone number is required' });
      }

      if (email) {
        const emailErr = getRegistrationEmailError(email);
        if (emailErr) {
          return res.status(400).json({ message: emailErr });
        }
      }

      if (phone) {
        const phoneErr = validatePhone(phone);
        if (phoneErr) {
          return res.status(400).json({ message: phoneErr });
        }
      }

      if (email) {
        const existingEmail = await User.findOne({ email });
        if (existingEmail) {
          return res.status(409).json({ message: 'Email is already registered' });
        }
      }

      if (phone) {
        const existingPhone = await User.findOne({ phone });
        if (existingPhone) {
          return res.status(409).json({ message: 'Phone number is already registered' });
        }
      }

      const userPayload = {
        name,
        password,
        role: 'personal_khata',
        status: 'approved',
        partyId: '',
        partyName: '',
      };

      if (email) userPayload.email = email;
      if (phone) userPayload.phone = phone;

      const user = await User.create(userPayload);
      user.ownerId = user._id;
      user.approvedBy = user._id;
      user.approvedAt = new Date();
      await user.save({ validateBeforeSave: false });

      return sendAuthResponse(res, 201, user, {
        message: 'Personal Khata account created. You are now signed in.',
      });
    }

    if (!email) {
      return res.status(400).json({ message: 'Name, email, and password are required' });
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

    const hasSuperAdmin = await User.exists({
      role: 'super_admin',
      status: 'approved',
    });

    if (requestedRole === 'admin') {
      const needsSuperApproval = !!hasSuperAdmin;

      if (needsSuperApproval) {
        const user = await User.create({
          name,
          email,
          password,
          role: 'admin',
          status: 'pending',
          partyId: '',
          partyName: '',
        });

        return res.status(201).json({
          message:
            'Your administrator account was created. The platform super administrator must approve it before you can sign in. You will receive access after approval.',
          user,
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
          'No approved organization administrator is available yet. Your administrator must register (and be verified by the platform) before party users can join.',
      });
    }

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
    const dupMsg = duplicateIdentityMessage(error);
    if (dupMsg) {
      return res.status(409).json({ message: dupMsg });
    }

    res.status(400).json({ message: 'Error creating user', error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = req.body.email && req.body.email.trim().toLowerCase();
    const phone = normalizePhone(req.body.phone);
    const { password } = req.body;

    if ((!email && !phone) || !password) {
      return res.status(400).json({ message: 'Email or phone and password are required' });
    }

    if (email) {
      const emailErr = getRegistrationEmailError(email);
      if (emailErr) {
        return res.status(400).json({ message: emailErr });
      }
    }

    if (phone) {
      const phoneErr = validatePhone(phone);
      if (phoneErr) {
        return res.status(400).json({ message: phoneErr });
      }
    }

    const user = phone
      ? await User.findOne({ phone }).select('+password')
      : await User.findOne({ email }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      const label = phone ? 'phone number' : 'email';
      return res.status(401).json({ message: `Invalid ${label} or password` });
    }

    if (user.status !== 'approved') {
      const pendingMsg =
        user.role === 'admin'
          ? 'Your administrator account is waiting for approval by the platform super administrator. Try again after you are verified.'
          : user.role === 'personal_khata'
            ? 'Your Personal Khata account is not active yet.'
            : 'Your account is waiting for business administrator approval';

      const messages = {
        pending: pendingMsg,
        rejected: 'Your account request was rejected',
        disabled: 'Your account has been disabled',
      };

      return res.status(403).json({
        message: messages[user.status] || 'Account is not approved',
        code: user.status === 'pending' && user.role === 'admin' ? 'ADMIN_PENDING_SUPER_APPROVAL' : undefined,
      });
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
    const phone = normalizePhone(req.body.phone);

    if (!email && !phone) {
      return res.status(400).json({ message: 'Email or phone number is required' });
    }

    if (email) {
      const emailErr = getRegistrationEmailError(email);
      if (emailErr) {
        return res.status(400).json({ message: emailErr });
      }
    }

    if (phone) {
      const phoneErr = validatePhone(phone);
      if (phoneErr) {
        return res.status(400).json({ message: phoneErr });
      }
    }

    const user = phone
      ? await User.findOne({ phone }).select('+passwordResetToken +passwordResetExpires')
      : await User.findOne({ email }).select('+passwordResetToken +passwordResetExpires');

    if (!user) {
      return res.json({
        message:
          'If that account is registered, a reset link has been sent. Check your inbox and spam folder.',
      });
    }

    if (!user.email) {
      return res.status(400).json({
        message:
          'This account has no email address on file. Password reset is only available for accounts registered with email. Register again with email or contact support.',
        code: 'NO_EMAIL_ON_ACCOUNT',
      });
    }

    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${getFrontendUrl()}/reset-password/${resetToken}`;
    const mailConfigError = getMailConfigError();

    if (mailConfigError) {
      if (process.env.NODE_ENV === 'production') {
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save({ validateBeforeSave: false });

        return res.status(503).json({
          message:
            'Password reset email is not configured on the server. Contact support or try again later.',
        });
      }

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

    res.json({
      message: 'If that account is registered, a reset link has been sent. Check your inbox and spam folder.',
    });
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
      const msg =
        user.role === 'admin'
          ? 'Password updated. You can sign in after the platform super administrator approves your account.'
          : user.role === 'personal_khata'
            ? 'Password updated. You can sign in with your new password.'
            : 'Password reset successfully. You can sign in after your business administrator approves your account.';
      return res.json({ message: msg, user });
    }

    sendAuthResponse(res, 200, user, {
      message: 'Password updated successfully.',
    });
  } catch (error) {
    res.status(500).json({ message: 'Error resetting password', error: error.message });
  }
});

module.exports = router;
