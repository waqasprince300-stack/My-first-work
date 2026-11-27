const { invalidateAuthUserCache } = require("../middleware/auth");
const { clearCache } = require("./requestCache");
const Announcement = require("../models/Announcement");
const BusinessOwner = require("../models/BusinessOwner");
const Collection = require("../models/Collection");
const Dashboard = require("../models/Dashboard");
const GhausiaLot = require("../models/GhausiaLot");
const Notification = require("../models/Notification");
const Otp = require("../models/Otp");
const OwnerBill = require("../models/OwnerBill");
const Party = require("../models/Party");
const PartyEdit = require("../models/PartyEdit");
const PartyLedger = require("../models/PartyLedger");
const Payment = require("../models/Payment");
const PersonalKhata = require("../models/PersonalKhata");
const RateCalculation = require("../models/RateCalculation");
const SavedDesign = require("../models/SavedDesign");
const User = require("../models/User");

const MAX_DISABLE_REASON_LEN = 300;

/** Trim and cap an optional account disable reason string. */
const normalizeDisableReason = (reason) =>
  String(reason || "").trim().slice(0, MAX_DISABLE_REASON_LEN);

/** Transition any non-super-admin user into the disabled state and bust auth cache. */
async function applyUserDisable(user, reason) {
  user.status = "disabled";
  user.disabledAt = new Date();
  user.disabledReason = normalizeDisableReason(reason);
  await user.save({ validateBeforeSave: false });
  invalidateAuthUserCache(user._id);
  clearCache("bootstrap");
  return user;
}

/**
 * Safely delete ONLY a party user's login account and login-private items (OTP/notifications).
 * Business Parties, Lots, Edits, Ledger entries, Payments, and Owner Bills remain untouched.
 */
async function deletePartyUserLoginOnly(user) {
  const userId = user._id;
  await Promise.all([
    Notification.deleteMany({ userId }),
    Otp.deleteMany({ userId }),
    User.deleteOne({ _id: userId }),
  ]);
  invalidateAuthUserCache(userId);
  clearCache("bootstrap");
  return {
    deleted: true,
    id: String(userId),
    name: user.name,
    email: user.email,
    preservedBusinessData: true,
  };
}

/** Count tenant data and linked party logins owned by an organization admin. */
async function getOrganizationImpact(adminId) {
  const [
    workspaces,
    parties,
    lots,
    payments,
    ownerBills,
    collections,
    rateCalculations,
    savedDesigns,
    partyUsers,
  ] = await Promise.all([
    BusinessOwner.countDocuments({ userId: adminId }),
    Party.countDocuments({ userId: adminId }),
    GhausiaLot.countDocuments({ userId: adminId }),
    Payment.countDocuments({ userId: adminId }),
    OwnerBill.countDocuments({ userId: adminId }),
    Collection.countDocuments({ userId: adminId }),
    RateCalculation.countDocuments({ userId: adminId }),
    SavedDesign.countDocuments({ userId: adminId }),
    User.countDocuments({
      role: "party",
      $or: [{ ownerId: adminId }, { pendingForAdminId: adminId }],
    }),
  ]);

  const requiresEmailConfirmation =
    workspaces > 0 ||
    parties > 0 ||
    lots > 0 ||
    payments > 0 ||
    ownerBills > 0 ||
    collections > 0 ||
    rateCalculations > 0 ||
    savedDesigns > 0 ||
    partyUsers > 0;

  return {
    workspaces,
    parties,
    lots,
    payments,
    ownerBills,
    collections,
    rateCalculations,
    savedDesigns,
    partyUsers,
    requiresEmailConfirmation,
  };
}

/**
 * Permanently delete an organization admin, all tenant collections, and all linked party logins.
 * Clears auth and bootstrap caches for every removed account.
 */
async function cascadeDeleteOrganizationAdmin(adminUser) {
  const adminId = adminUser._id;
  const linkedPartyUsers = await User.find({
    role: "party",
    $or: [{ ownerId: adminId }, { pendingForAdminId: adminId }],
  })
    .select("_id")
    .lean();

  const partyUserIds = linkedPartyUsers.map((u) => u._id);
  const allUserIds = [adminId, ...partyUserIds];

  await Promise.all([
    GhausiaLot.deleteMany({ userId: adminId }),
    PartyEdit.deleteMany({ userId: adminId }),
    PartyLedger.deleteMany({ userId: adminId }),
    Payment.deleteMany({ userId: adminId }),
    OwnerBill.deleteMany({ userId: adminId }),
    Party.deleteMany({ userId: adminId }),
    Collection.deleteMany({ userId: adminId }),
    RateCalculation.deleteMany({ userId: adminId }),
    SavedDesign.deleteMany({ userId: adminId }),
    BusinessOwner.deleteMany({ userId: adminId }),
    Dashboard.deleteMany({ userId: adminId }),
    Announcement.deleteMany({ ownerId: adminId }),
    Notification.deleteMany({
      $or: [{ ownerId: adminId }, { userId: { $in: allUserIds } }],
    }),
    Otp.deleteMany({ userId: { $in: allUserIds } }),
    PersonalKhata.deleteMany({ userId: { $in: allUserIds } }),
  ]);

  if (partyUserIds.length > 0) {
    await User.deleteMany({ _id: { $in: partyUserIds } });
  }
  await User.deleteOne({ _id: adminId });

  for (const uid of allUserIds) {
    invalidateAuthUserCache(uid);
  }
  clearCache("bootstrap");

  return {
    deleted: true,
    id: String(adminId),
    email: adminUser.email,
    deletedPartyUserCount: partyUserIds.length,
    deletedPartyUserIds: partyUserIds.map(String),
  };
}

module.exports = {
  applyUserDisable,
  deletePartyUserLoginOnly,
  getOrganizationImpact,
  cascadeDeleteOrganizationAdmin,
};
