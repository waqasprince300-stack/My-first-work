const crypto = require("crypto");
const Otp = require("../models/Otp");
const { getMailConfigError, sendOtpEmail } = require("./email");
const { getSmsConfigError, sendSms } = require("./sms");

const OTP_TTL_MINUTES = Number(process.env.OTP_EXPIRES_MINUTES) || 10;
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;
const OTP_MAX_RESENDS = Number(process.env.OTP_MAX_RESENDS) || 6;

const generateCode = () =>
  String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

const hashCode = (code) =>
  crypto.createHash("sha256").update(String(code)).digest("hex");

const maskEmail = (email) => {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at <= 0) return s ? `${s[0]}***` : "";
  const name = s.slice(0, at);
  const domain = s.slice(at + 1);
  const shownName = name.length <= 2 ? `${name[0]}*` : `${name.slice(0, 2)}***`;
  return `${shownName}@${domain}`;
};

const maskPhone = (phone) => {
  const s = String(phone || "");
  const digits = s.replace(/\D/g, "");
  if (digits.length < 4) return s ? "***" : "";
  const last = digits.slice(-3);
  const plus = s.startsWith("+") ? "+" : "";
  return `${plus}${"*".repeat(Math.max(2, digits.length - 3))}${last}`;
};

const maskDestination = (channel, dest) =>
  channel === "sms" ? maskPhone(dest) : maskEmail(dest);

/** Channels this user can actually receive a code on. */
const availableChannels = (user) => {
  const list = [];
  if (user.email) list.push("email");
  if (user.phone) list.push("sms");
  return list;
};

/** Pick the channel: honor a valid preference, else phone-only/email-only, else default email. */
const resolveChannel = (user, preferred) => {
  const hasEmail = !!user.email;
  const hasPhone = !!user.phone;
  const pref = String(preferred || "").toLowerCase();
  if (pref === "sms" && hasPhone) return "sms";
  if (pref === "email" && hasEmail) return "email";
  if (hasEmail) return "email";
  if (hasPhone) return "sms";
  return null;
};

const deliverOtp = async ({ user, channel, code, purpose }) => {
  if (channel === "email") {
    const cfgErr = getMailConfigError();
    if (cfgErr) return { delivered: false, note: cfgErr.message };
    await sendOtpEmail({
      to: user.email,
      name: user.name,
      code,
      purpose,
      expiryMinutes: OTP_TTL_MINUTES,
    });
    return { delivered: true, note: "" };
  }

  // SMS
  const cfgErr = getSmsConfigError();
  if (cfgErr) return { delivered: false, note: cfgErr.message };
  const text = `Waqas EMB verification code: ${code} (expires in ${OTP_TTL_MINUTES} min)`;
  const res = await sendSms({ to: user.phone, text });
  return {
    delivered: !!res.delivered,
    note: res.delivered
      ? ""
      : "SMS gateway is in log mode — no real message was sent.",
  };
};

/**
 * Create a fresh OTP for a user and attempt delivery.
 * Older un-consumed OTPs of the same purpose are invalidated.
 *
 * @returns {{ otp, channel, channels, destinationMasked, devCode?, deliveryNote }}
 */
const createAndSendOtp = async ({
  user,
  purpose,
  preferredChannel,
  deviceId,
}) => {
  const channel = resolveChannel(user, preferredChannel);
  if (!channel) {
    const err = new Error(
      "No email or phone number is on file to send a verification code.",
    );
    err.code = "NO_OTP_DESTINATION";
    throw err;
  }

  await Otp.updateMany(
    { userId: user._id, purpose, consumed: false },
    { $set: { consumed: true } },
  );

  const code = generateCode();
  const destination = channel === "sms" ? user.phone : user.email;

  const otp = await Otp.create({
    userId: user._id,
    purpose,
    channel,
    destination,
    codeHash: hashCode(code),
    deviceId: deviceId || "",
    expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
  });

  let delivery;
  try {
    delivery = await deliverOtp({ user, channel, code, purpose });
  } catch (e) {
    delivery = { delivered: false, note: e.message };
  }

  // Expose the code to the client only when it could NOT actually be delivered (so nobody is
  // ever locked out before a gateway is connected). Once email/SMS delivers, the code is never
  // returned — even in development. Set OTP_DEBUG_RETURN=1 to force-return it while testing.
  const debugReturn =
    String(process.env.OTP_DEBUG_RETURN || "").toLowerCase() === "true" ||
    process.env.OTP_DEBUG_RETURN === "1";
  const exposeCode = !delivery.delivered || debugReturn;

  return {
    otp,
    channel,
    channels: availableChannels(user),
    destinationMasked: maskDestination(channel, destination),
    devCode: exposeCode ? code : undefined,
    deliveryNote: delivery.note || "",
  };
};

/** @returns {{ ok: boolean, reason?: 'invalid'|'expired'|'too_many'|'mismatch' }} */
const checkOtp = (otp, code) => {
  if (!otp || otp.consumed) return { ok: false, reason: "invalid" };
  if (otp.expiresAt.getTime() < Date.now())
    return { ok: false, reason: "expired" };
  if (otp.attempts >= OTP_MAX_ATTEMPTS)
    return { ok: false, reason: "too_many" };
  if (otp.codeHash !== hashCode(code)) return { ok: false, reason: "mismatch" };
  return { ok: true };
};

const otpErrorMessage = (reason) => {
  switch (reason) {
    case "expired":
      return "This code has expired. Request a new one.";
    case "too_many":
      return "Too many incorrect attempts. Request a new code.";
    case "mismatch":
      return "Incorrect code. Please check and try again.";
    default:
      return "This code is invalid or has expired. Request a new one.";
  }
};

module.exports = {
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_RESENDS,
  hashCode,
  maskDestination,
  availableChannels,
  resolveChannel,
  createAndSendOtp,
  checkOtp,
  otpErrorMessage,
};
