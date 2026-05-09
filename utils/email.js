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

  return nodemailer.createTransport({
    host: getEnv('SMTP_HOST'),
    port: Number(getEnv('SMTP_PORT')),
    secure: getEnv('SMTP_SECURE').toLowerCase() === 'true',
    auth: {
      user: getEnv('SMTP_USER'),
      pass: getEnv('SMTP_PASS').replace(/\s+/g, ''),
    },
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

module.exports = {
  getMailConfigError,
  sendPasswordResetEmail,
};
