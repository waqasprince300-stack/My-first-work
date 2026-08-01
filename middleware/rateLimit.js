const rateLimit = require("express-rate-limit");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many attempts. Please wait a few minutes and try again.",
  },
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.OTP_RATE_LIMIT_MAX) || 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many verification requests. Please wait and try again.",
  },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many requests. Please wait and try again.",
  },
});

module.exports = {
  authLimiter,
  otpLimiter,
  apiLimiter,
};
