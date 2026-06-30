const nodemailer = require('nodemailer');

const requiredMailConfig = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
const placeholderValues = new Set([
  'your-email@gmail.com',
  'your-app-password',
  'your-google-app-password',
]);

const getEnv = (key) => String(process.env[key] || '').trim();

const ensureMailConfig = () => {
  const missing = requiredMailConfig.filter((key) => !getEnv(key));

  if (missing.length > 0) {
    throw new Error(`Missing email configuration: ${missing.join(', ')}`);
  }

  const placeholders = requiredMailConfig.filter((key) => placeholderValues.has(getEnv(key)));

  if (placeholders.length > 0) {
    throw new Error(`Replace placeholder email configuration: ${placeholders.join(', ')}`);
  }
};

const getMailConfigError = () => {
  try {
    ensureMailConfig();
    return null;
  } catch (error) {
    return error;
  }
};

const createTransporter = () => {
  ensureMailConfig();

  const port = Number(getEnv('SMTP_PORT')) || 587;
  const secureEnv = getEnv('SMTP_SECURE').toLowerCase();
  // Port 465 = implicit TLS (secure). 587/25 = STARTTLS (secure:false). Auto-detect if unset.
  const secure = secureEnv ? secureEnv === 'true' : port === 465;

  return nodemailer.createTransport({
    host: getEnv('SMTP_HOST'),
    port,
    secure,
    auth: {
      user: getEnv('SMTP_USER'),
      pass: getEnv('SMTP_PASS').replace(/\s+/g, ''),
    },
    // Fail fast instead of hanging the login/OTP request when the SMTP port is blocked.
    connectionTimeout: 12_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
  });
};

const sendPasswordResetEmail = async ({ to, name, resetUrl }) => {
  const transporter = createTransporter();
  const from = getEnv('EMAIL_FROM') || getEnv('SMTP_USER');

  await transporter.sendMail({
    from,
    to,
    subject: 'Reset your Waqas EMB password',
    text: [
      `Hi ${name || 'there'},`,
      '',
      'You requested a password reset for your Waqas EMB account.',
      `Open this link to set a new password: ${resetUrl}`,
      '',
      'This link will expire soon. If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: `
      <p>Hi ${name || 'there'},</p>
      <p>You requested a password reset for your Waqas EMB account.</p>
      <p><a href="${resetUrl}">Click here to reset your password</a></p>
      <p>This link will expire soon. If you did not request this, you can ignore this email.</p>
    `,
  });
};

const OTP_PURPOSE_COPY = {
  login_device: {
    subject: 'Your Waqas EMB sign-in code',
    line: 'Use this code to confirm sign-in from a new device.',
  },
  password_reset: {
    subject: 'Your Waqas EMB password reset code',
    line: 'Use this code to reset your password.',
  },
};

/** Send a one-time verification code (new-device login or password reset). */
const sendOtpEmail = async ({ to, name, code, purpose, expiryMinutes }) => {
  const transporter = createTransporter();
  const from = getEnv('EMAIL_FROM') || getEnv('SMTP_USER');
  const copy = OTP_PURPOSE_COPY[purpose] || OTP_PURPOSE_COPY.login_device;
  const minutes = Number(expiryMinutes) || 10;

  await transporter.sendMail({
    from,
    to,
    subject: copy.subject,
    text: [
      `Hi ${name || 'there'},`,
      '',
      copy.line,
      '',
      `Your code: ${code}`,
      `It expires in ${minutes} minutes.`,
      '',
      'If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: `
      <p>Hi ${name || 'there'},</p>
      <p>${copy.line}</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0;">${code}</p>
      <p>This code expires in ${minutes} minutes.</p>
      <p>If you did not request this, you can ignore this email.</p>
    `,
  });
};

module.exports = {
  getMailConfigError,
  sendPasswordResetEmail,
  sendOtpEmail,
};
