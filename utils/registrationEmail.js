/**
 * Registration must use real-looking addresses — block example, disposable,
 * and local test domains. Keep in sync with frontend src/utils/registrationEmail.js
 */

/** Domains that must not be used for signup (includes common disposable providers). */
const BLOCKED_DOMAIN_SUFFIXES = [
  "example.com",
  "example.org",
  "example.net",
  "example.edu",
  "test.com",
  "test.org",
  "localhost",
  "invalid",
  "mailinator.com",
  "yopmail.com",
  "yopmail.fr",
  "guerrillamail.com",
  "guerrillamail.biz",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwaway.email",
  "trashmail.com",
  "fakeinbox.com",
  "mailnesia.com",
  "getnada.com",
  "dispostable.com",
  "sharklasers.com",
  "emailondeck.com",
  "mohmal.com",
];

const EMAIL_SHAPE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function domainMatchesBlocklist(domainLower) {
  const d = String(domainLower || "").toLowerCase();
  if (!d) return true;

  if (
    d === "local" ||
    d.endsWith(".local") ||
    d.endsWith(".invalid") ||
    d.endsWith(".test")
  ) {
    return true;
  }

  for (const suffix of BLOCKED_DOMAIN_SUFFIXES) {
    if (d === suffix || d.endsWith(`.${suffix}`)) {
      return true;
    }
  }

  // Pure numeric host (e.g. @127.0.0.1 style if ever used)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(d)) {
    return true;
  }

  return false;
}

/**
 * @returns {string|null} Error message, or null if acceptable.
 */
function getRegistrationEmailError(email) {
  if (email == null || String(email).trim() === "") {
    return "Email is required";
  }

  const normalized = String(email).trim().toLowerCase();

  if (normalized.length > 254) {
    return "Email address is too long";
  }

  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) {
    return "Enter a valid email address with a domain (e.g. name@yourcompany.com)";
  }

  const domain = normalized.slice(at + 1);

  if (!EMAIL_SHAPE.test(normalized)) {
    return "Enter a valid email address";
  }

  if (domainMatchesBlocklist(domain)) {
    return "Example, disposable, or test email domains cannot be used. Register with a real work or personal email you control.";
  }

  return null;
}

module.exports = {
  getRegistrationEmailError,
  BLOCKED_DOMAIN_SUFFIXES,
};
