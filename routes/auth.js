const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Otp = require("../models/Otp");
const authenticate = require("../middleware/auth");
const {
  getMailConfigError,
  sendPasswordResetEmail,
} = require("../utils/email");
const { getRegistrationEmailError } = require("../utils/registrationEmail");
const { normalizePhone, validatePhone } = require("../utils/phone");
const {
  OTP_MAX_RESENDS,
  createAndSendOtp,
  checkOtp,
  otpErrorMessage,
} = require("../utils/otp");

const { authLimiter, otpLimiter } = require("../middleware/rateLimit");

const router = express.Router();

const getJwtSecret = () => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required");
  }

  return "development-jwt-secret-change-me";
};

const signToken = (userId) => {
  return jwt.sign({ id: userId }, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

/** Remember the device (so it skips OTP next time), then return a signed session. */
const respondWithToken = async (
  res,
  statusCode,
  user,
  { deviceId, deviceLabel, ...extra } = {},
) => {
  if (deviceId) {
    try {
      user.rememberDevice(deviceId, deviceLabel || "");
      await user.save({ validateBeforeSave: false });
    } catch {
      /* non-fatal: device just won't be remembered */
    }
  }

  const token = signToken(user._id);
  res.status(statusCode).json({
    token,
    user,
    ...extra,
  });
};

const otpResponseFields = (result) => ({
  channel: result.channel,
  channels: result.channels,
  destinationMasked: result.destinationMasked,
  ...(result.devCode ? { devCode: result.devCode } : {}),
  ...(result.deliveryNote ? { deliveryNote: result.deliveryNote } : {}),
});

const normalizeSignupRole = (role) => {
  const r = String(role || "party").toLowerCase();
  if (r === "admin") return "admin";
  if (r === "personal_khata") return "personal_khata";
  return "party";
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
  email: email ? String(email).trim().toLowerCase() : "",
  phone: normalizePhone(phone),
  password,
  role: normalizeSignupRole(role),
  partyId: partyId ? String(partyId).trim() : "",
  partyName: partyName ? String(partyName).trim() : "",
  adminEmail: adminEmail ? String(adminEmail).trim().toLowerCase() : "",
});

const getFrontendUrl = () => {
  return (
    process.env.FRONTEND_URL ||
    process.env.CORS_ORIGIN ||
    "http://localhost:3000"
  )
    .split(",")[0]
    .trim()
    .replace(/\/$/, "");
};

const duplicateIdentityMessage = (error) => {
  if (error.code !== 11000) return null;
  const key = Object.keys(error.keyPattern || error.keyValue || {})[0] || "";
  if (key.includes("email")) return "Email is already registered";
  if (key.includes("phone")) return "Phone number is already registered";
  return "Account already exists";
};

router.post("/signup", authLimiter, async (req, res) => {
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
    const deviceId = String(req.body.deviceId || "").trim();
    const deviceLabel = String(req.body.deviceLabel || "").trim();

    if (!name || !password) {
      return res
        .status(400)
        .json({ message: "Name and password are required" });
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters long" });
    }

    if (requestedRole === "personal_khata") {
      if (!email && !phone) {
        return res
          .status(400)
          .json({ message: "Email or phone number is required" });
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
          return res
            .status(409)
            .json({ message: "Email is already registered" });
        }
      }

      if (phone) {
        const existingPhone = await User.findOne({ phone });
        if (existingPhone) {
          return res
            .status(409)
            .json({ message: "Phone number is already registered" });
        }
      }

      const userPayload = {
        name,
        password,
        role: "personal_khata",
        status: "approved",
        partyId: "",
        partyName: "",
      };

      if (email) userPayload.email = email;
      if (phone) userPayload.phone = phone;

      const user = await User.create(userPayload);
      user.ownerId = user._id;
      user.approvedBy = user._id;
      user.approvedAt = new Date();
      await user.save({ validateBeforeSave: false });

      return respondWithToken(res, 201, user, {
        deviceId,
        deviceLabel,
        message: "Personal Khata account created. You are now signed in.",
      });
    }

    if (!email) {
      return res
        .status(400)
        .json({ message: "Name, email, and password are required" });
    }

    const emailErr = getRegistrationEmailError(email);
    if (emailErr) {
      return res.status(400).json({ message: emailErr });
    }

    if (phone) {
      const phoneErr = validatePhone(phone);
      if (phoneErr) {
        return res.status(400).json({ message: phoneErr });
      }
      const existingPhone = await User.findOne({ phone });
      if (existingPhone) {
        return res
          .status(409)
          .json({ message: "Phone number is already registered" });
      }
    }

    if (adminEmail) {
      const adminEmailErr = getRegistrationEmailError(adminEmail);
      if (adminEmailErr) {
        return res
          .status(400)
          .json({ message: `Business administrator email: ${adminEmailErr}` });
      }
    }

    const approvedAdminCount = await User.countDocuments({
      role: "admin",
      status: "approved",
    });

    const hasSuperAdmin = await User.exists({
      role: "super_admin",
      status: "approved",
    });

    if (requestedRole === "admin") {
      const needsSuperApproval = !!hasSuperAdmin;

      if (needsSuperApproval) {
        const user = await User.create({
          name,
          email,
          ...(phone ? { phone } : {}),
          password,
          role: "admin",
          status: "pending",
          partyId: "",
          partyName: "",
        });

        return res.status(201).json({
          message:
            "Your administrator account was created. The platform super administrator must approve it before you can sign in. You will receive access after approval.",
          user,
        });
      }

      const user = await User.create({
        name,
        email,
        ...(phone ? { phone } : {}),
        password,
        role: "admin",
        status: "approved",
        partyId: "",
        partyName: "",
      });

      user.ownerId = user._id;
      user.approvedBy = user._id;
      user.approvedAt = new Date();
      await user.save({ validateBeforeSave: false });
      return respondWithToken(res, 201, user, {
        deviceId,
        deviceLabel,
        message:
          "Organization administrator account created. You are now signed in.",
      });
    }

    if (approvedAdminCount === 0) {
      return res.status(400).json({
        message:
          "No approved organization administrator is available yet. Your administrator must register (and be verified by the platform) before party users can join.",
      });
    }

    if (!adminEmail) {
      return res.status(400).json({
        message:
          "Provide the email of the business administrator you are requesting to join.",
      });
    }

    const targetAdmin = await User.findOne({
      email: adminEmail,
      role: "admin",
      status: "approved",
    });

    if (!targetAdmin) {
      return res.status(400).json({
        message:
          "No approved business administrator was found for that email. Check the address or try again after your org has an approved admin.",
      });
    }

    const user = await User.create({
      name,
      email,
      ...(phone ? { phone } : {}),
      password,
      role: "party",
      status: "pending",
      partyId,
      partyName,
      pendingForAdminId: targetAdmin._id,
    });

    res.status(201).json({
      message:
        "Account created and waiting for your business administrator to approve",
      user,
    });
  } catch (error) {
    const dupMsg = duplicateIdentityMessage(error);
    if (dupMsg) {
      return res.status(409).json({ message: dupMsg });
    }

    res
      .status(400)
      .json({ message: "Error creating user", error: error.message });
  }
});

/** Build the 403 body for a not-yet-usable account (pending/rejected/disabled). */
const notApprovedResponse = (res, user) => {
  const pendingMsg =
    user.role === "admin"
      ? "Your administrator account is waiting for approval by the platform super administrator. Try again after you are verified."
      : user.role === "personal_khata"
        ? "Your Personal Khata account is not active yet."
        : "Your account is waiting for business administrator approval";

  const messages = {
    pending: pendingMsg,
    rejected: "Your account request was rejected",
    disabled: "Your account has been disabled",
  };

  return res.status(403).json({
    message: messages[user.status] || "Account is not approved",
    code:
      user.status === "pending" && user.role === "admin"
        ? "ADMIN_PENDING_SUPER_APPROVAL"
        : undefined,
  });
};

router.post("/login", authLimiter, async (req, res) => {
  try {
    const email = req.body.email && req.body.email.trim().toLowerCase();
    const phone = normalizePhone(req.body.phone);
    const { password } = req.body;
    const deviceId = String(req.body.deviceId || "").trim();
    const deviceLabel = String(req.body.deviceLabel || "").trim();

    if ((!email && !phone) || !password) {
      return res
        .status(400)
        .json({ message: "Email or phone and password are required" });
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
      ? await User.findOne({ phone }).select("+password +knownDevices")
      : await User.findOne({ email }).select("+password +knownDevices");

    if (!user || !(await user.comparePassword(password))) {
      const label = phone ? "phone number" : "email";
      return res.status(401).json({ message: `Invalid ${label} or password` });
    }

    if (user.status !== "approved") {
      return notApprovedResponse(res, user);
    }

    if (user.role !== "super_admin" && !deviceId) {
      return res.status(400).json({
        message:
          "A device identifier is required. Please sign in using the official web app.",
        code: "DEVICE_ID_REQUIRED",
      });
    }

    // Super admins always skip OTP. Other roles get a code on a new (or unknown) device.
    const needsDeviceOtp =
      user.role !== "super_admin" && !user.hasKnownDevice(deviceId);

    if (!needsDeviceOtp) {
      return respondWithToken(res, 200, user, { deviceId, deviceLabel });
    }

    try {
      const result = await createAndSendOtp({
        user,
        purpose: "login_device",
        preferredChannel: req.body.otpChannel || (phone ? "sms" : "email"),
        deviceId,
      });

      return res.status(200).json({
        otpRequired: true,
        otpId: result.otp._id,
        purpose: "login_device",
        message: `For your security, enter the code we sent to your ${result.channel === "sms" ? "phone" : "email"} to confirm this new device.`,
        ...otpResponseFields(result),
      });
    } catch (otpErr) {
      // No email/phone to send to → don't lock the user out; issue the session directly.
      if (otpErr.code === "NO_OTP_DESTINATION") {
        return respondWithToken(res, 200, user, { deviceId, deviceLabel });
      }
      throw otpErr;
    }
  } catch (error) {
    res.status(500).json({ message: "Error logging in", error: error.message });
  }
});

router.post("/login/verify-otp", otpLimiter, async (req, res) => {
  try {
    const otpId = String(req.body.otpId || "").trim();
    const code = String(req.body.code || "").trim();
    const deviceId = String(req.body.deviceId || "").trim();
    const deviceLabel = String(req.body.deviceLabel || "").trim();

    if (!otpId || !code) {
      return res.status(400).json({ message: "Verification code is required" });
    }

    const otp = await Otp.findById(otpId).select("+codeHash");
    if (!otp || otp.purpose !== "login_device") {
      return res
        .status(400)
        .json({
          message: "This code is invalid or has expired. Request a new one.",
        });
    }

    const check = checkOtp(otp, code);
    if (!check.ok) {
      if (check.reason === "mismatch") {
        otp.attempts += 1;
        await otp.save();
      }
      return res.status(400).json({ message: otpErrorMessage(check.reason) });
    }

    otp.consumed = true;
    await otp.save();

    const user = await User.findById(otp.userId).select("+knownDevices");
    if (!user) {
      return res.status(401).json({ message: "Account no longer exists" });
    }
    if (user.status !== "approved") {
      return notApprovedResponse(res, user);
    }

    return respondWithToken(res, 200, user, {
      deviceId: deviceId || otp.deviceId,
      deviceLabel,
      message: "Device verified. You are now signed in.",
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error verifying code", error: error.message });
  }
});

router.post("/login/resend-otp", otpLimiter, async (req, res) => {
  try {
    const otpId = String(req.body.otpId || "").trim();
    const channel = req.body.channel;

    const prev = await Otp.findById(otpId);
    if (!prev || prev.purpose !== "login_device") {
      return res
        .status(400)
        .json({ message: "Could not resend the code. Please sign in again." });
    }

    if ((prev.resendCount || 0) >= OTP_MAX_RESENDS) {
      return res
        .status(429)
        .json({
          message:
            "Too many code requests. Please wait a while and sign in again.",
        });
    }

    const user = await User.findById(prev.userId).select("+knownDevices");
    if (!user) {
      return res.status(401).json({ message: "Account no longer exists" });
    }

    const result = await createAndSendOtp({
      user,
      purpose: "login_device",
      preferredChannel: channel || prev.channel,
      deviceId: prev.deviceId,
    });

    result.otp.resendCount = (prev.resendCount || 0) + 1;
    await result.otp.save();

    return res.json({
      otpId: result.otp._id,
      message: "A new code has been sent.",
      ...otpResponseFields(result),
    });
  } catch (error) {
    if (error.code === "NO_OTP_DESTINATION") {
      return res.status(400).json({ message: error.message });
    }
    res
      .status(500)
      .json({ message: "Error resending code", error: error.message });
  }
});

router.get("/me", authenticate, async (req, res) => {
  res.json({ user: req.user });
});

/**
 * OTP-based password reset (email or phone).
 * Returns a generic message; `otpId` is only included when an account was found.
 */
router.post("/password-reset/request", authLimiter, async (req, res) => {
  try {
    const email = req.body.email && req.body.email.trim().toLowerCase();
    const phone = normalizePhone(req.body.phone);
    const channel = req.body.channel;

    if (!email && !phone) {
      return res
        .status(400)
        .json({ message: "Email or phone number is required" });
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

    const generic =
      "If that account is registered, a verification code has been sent.";
    const user = phone
      ? await User.findOne({ phone })
      : await User.findOne({ email });

    if (!user) {
      return res.json({ message: generic });
    }

    try {
      const result = await createAndSendOtp({
        user,
        purpose: "password_reset",
        preferredChannel: channel || (phone ? "sms" : "email"),
      });

      return res.json({
        message: generic,
        otpId: result.otp._id,
        ...otpResponseFields(result),
      });
    } catch (otpErr) {
      if (otpErr.code === "NO_OTP_DESTINATION") {
        return res.status(400).json({
          message:
            "This account has no email or phone on file to send a code to. Contact support.",
          code: "NO_OTP_DESTINATION",
        });
      }
      throw otpErr;
    }
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error sending reset code", error: error.message });
  }
});

router.post("/password-reset/verify", otpLimiter, async (req, res) => {
  try {
    const otpId = String(req.body.otpId || "").trim();
    const code = String(req.body.code || "").trim();
    const { password } = req.body;
    const deviceId = String(req.body.deviceId || "").trim();

    if (!otpId || !code) {
      return res.status(400).json({ message: "Verification code is required" });
    }
    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters long" });
    }

    const otp = await Otp.findById(otpId).select("+codeHash");
    if (!otp || otp.purpose !== "password_reset") {
      return res
        .status(400)
        .json({
          message: "This code is invalid or has expired. Request a new one.",
        });
    }

    const check = checkOtp(otp, code);
    if (!check.ok) {
      if (check.reason === "mismatch") {
        otp.attempts += 1;
        await otp.save();
      }
      return res.status(400).json({ message: otpErrorMessage(check.reason) });
    }

    otp.consumed = true;
    await otp.save();

    const user = await User.findById(otp.userId).select(
      "+password +knownDevices",
    );
    if (!user) {
      return res.status(400).json({ message: "Account no longer exists" });
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    if (user.status !== "approved") {
      const msg =
        user.role === "admin"
          ? "Password updated. You can sign in after the platform super administrator approves your account."
          : user.role === "personal_khata"
            ? "Password updated. You can sign in with your new password."
            : "Password reset successfully. You can sign in after your business administrator approves your account.";
      return res.json({ message: msg, user });
    }

    return respondWithToken(res, 200, user, {
      deviceId,
      message: "Password updated successfully. You are now signed in.",
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error resetting password", error: error.message });
  }
});

/**
 * Upgrade a Personal Khata account to a business administrator or party account.
 * The user id never changes, so the Personal Khata ledger stays linked.
 */
router.post("/account/upgrade", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      "+password +knownDevices",
    );
    if (!user) {
      return res.status(404).json({ message: "Account not found" });
    }
    if (user.role !== "personal_khata") {
      return res
        .status(400)
        .json({ message: "Only Personal Khata accounts can be upgraded." });
    }

    const targetRole =
      String(req.body.targetRole || "").toLowerCase() === "admin"
        ? "admin"
        : "party";

    // Business accounts sign in by email — make sure one is on file.
    if (!user.email) {
      const bodyEmail = req.body.email
        ? String(req.body.email).trim().toLowerCase()
        : "";
      if (!bodyEmail) {
        return res.status(400).json({
          message:
            "Business accounts sign in with email. Add an email address to upgrade.",
          code: "EMAIL_REQUIRED",
        });
      }
      const emailErr = getRegistrationEmailError(bodyEmail);
      if (emailErr) {
        return res.status(400).json({ message: emailErr });
      }
      const exists = await User.findOne({
        email: bodyEmail,
        _id: { $ne: user._id },
      });
      if (exists) {
        return res.status(409).json({ message: "Email is already registered" });
      }
      user.email = bodyEmail;
    }

    if (targetRole === "admin") {
      const hasSuperAdmin = await User.exists({
        role: "super_admin",
        status: "approved",
      });

      if (hasSuperAdmin) {
        user.role = "admin";
        user.status = "pending";
        await user.save({ validateBeforeSave: false });
        return res.json({
          message:
            "Upgrade requested. A platform super administrator must approve your business administrator account before you can sign in. Your Personal Khata data is safe and stays linked to this account.",
          user,
        });
      }

      user.role = "admin";
      user.status = "approved";
      user.ownerId = user._id;
      user.approvedBy = user._id;
      user.approvedAt = new Date();
      await user.save({ validateBeforeSave: false });
      return respondWithToken(res, 200, user, {
        message:
          "Upgraded to business administrator. You are now signed in as an admin.",
      });
    }

    // Party upgrade — needs an approved business administrator.
    const adminEmail = req.body.adminEmail
      ? String(req.body.adminEmail).trim().toLowerCase()
      : "";
    if (!adminEmail) {
      return res
        .status(400)
        .json({ message: "Enter your business administrator email." });
    }
    const adminErr = getRegistrationEmailError(adminEmail);
    if (adminErr) {
      return res
        .status(400)
        .json({ message: `Business administrator email: ${adminErr}` });
    }
    const targetAdmin = await User.findOne({
      email: adminEmail,
      role: "admin",
      status: "approved",
    });
    if (!targetAdmin) {
      return res.status(400).json({
        message: "No approved business administrator was found for that email.",
      });
    }

    user.role = "party";
    user.status = "pending";
    user.pendingForAdminId = targetAdmin._id;
    if (req.body.partyName) user.partyName = String(req.body.partyName).trim();
    if (req.body.partyId) user.partyId = String(req.body.partyId).trim();
    await user.save({ validateBeforeSave: false });

    return res.json({
      message:
        "Upgrade requested. Your business administrator must approve your party account before you can sign in. Your Personal Khata data is safe and stays linked to this account.",
      user,
    });
  } catch (error) {
    const dupMsg = duplicateIdentityMessage(error);
    if (dupMsg) {
      return res.status(409).json({ message: dupMsg });
    }
    res
      .status(500)
      .json({ message: "Error upgrading account", error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Legacy email-link password reset (kept for backward compatibility with any
// reset links already sent). The UI now uses the OTP flow above.
// ---------------------------------------------------------------------------
router.post("/forgot-password", authLimiter, async (req, res) => {
  try {
    const email = req.body.email && req.body.email.trim().toLowerCase();
    const phone = normalizePhone(req.body.phone);

    if (!email && !phone) {
      return res
        .status(400)
        .json({ message: "Email or phone number is required" });
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
      ? await User.findOne({ phone }).select(
          "+passwordResetToken +passwordResetExpires",
        )
      : await User.findOne({ email }).select(
          "+passwordResetToken +passwordResetExpires",
        );

    if (!user) {
      return res.json({
        message:
          "If that account is registered, a reset link has been sent. Check your inbox and spam folder.",
      });
    }

    if (!user.email) {
      return res.status(400).json({
        message:
          "This account has no email address on file. Password reset is only available for accounts registered with email. Register again with email or contact support.",
        code: "NO_EMAIL_ON_ACCOUNT",
      });
    }

    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${getFrontendUrl()}/reset-password/${resetToken}`;
    const mailConfigError = getMailConfigError();

    if (mailConfigError) {
      if (process.env.NODE_ENV === "production") {
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save({ validateBeforeSave: false });

        return res.status(503).json({
          message:
            "Password reset email is not configured on the server. Contact support or try again later.",
        });
      }

      return res.json({
        message:
          "Email is not configured. Use this development reset link instead.",
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
        message:
          "Unable to send password reset email. Please check email configuration.",
        error: emailError.message,
      });
    }

    res.json({
      message:
        "If that account is registered, a reset link has been sent. Check your inbox and spam folder.",
    });
  } catch (error) {
    res
      .status(500)
      .json({
        message: "Error generating password reset token",
        error: error.message,
      });
  }
});

router.patch("/reset-password/:token", async (req, res) => {
  try {
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters long" });
    }

    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select("+passwordResetToken +passwordResetExpires +password");

    if (!user) {
      return res
        .status(400)
        .json({ message: "Password reset token is invalid or has expired" });
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    if (user.status !== "approved") {
      const msg =
        user.role === "admin"
          ? "Password updated. You can sign in after the platform super administrator approves your account."
          : user.role === "personal_khata"
            ? "Password updated. You can sign in with your new password."
            : "Password reset successfully. You can sign in after your business administrator approves your account.";
      return res.json({ message: msg, user });
    }

    return respondWithToken(res, 200, user, {
      message: "Password updated successfully.",
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error resetting password", error: error.message });
  }
});

module.exports = router;
