/** Normalize phone for storage/lookup (matches frontend personalKhataAccount.js). */
function normalizePhone(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

function validatePhone(raw) {
  const n = normalizePhone(raw).replace(/^\+/, "");
  if (!n) return "Enter your mobile number.";
  if (n.length < 10)
    return "Phone number looks too short (use at least 10 digits).";
  if (n.length > 15) return "Phone number looks too long.";
  return "";
}

module.exports = {
  normalizePhone,
  validatePhone,
};
