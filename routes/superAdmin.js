const express = require("express");
const mongoose = require("mongoose");
const { invalidateAuthUserCache } = require("../middleware/auth");
const BusinessOwner = require("../models/BusinessOwner");
const GhausiaLot = require("../models/GhausiaLot");
const Party = require("../models/Party");
const User = require("../models/User");
const { validateObjectIdParam, toObjectId } = require("../utils/access");
const { parsePaginationQuery, paginatedJson } = require("../utils/pagination");
const {
  disconnectUserSockets,
  emitOrgChange,
} = require("../utils/realtime");
const { clearCache } = require("../utils/requestCache");
const {
  applyUserDisable,
  cascadeDeleteOrganizationAdmin,
  deletePartyUserLoginOnly,
  getOrganizationImpact,
} = require("../utils/userLifecycle");

const router = express.Router();

router.param("id", validateObjectIdParam);

const SAFE_USER_PROJECTION =
  "-password -passwordResetToken -passwordResetExpires";

/** Aggregate document counts grouped by an ObjectId field into a string-keyed Map. */
async function countByField(Model, field, adminObjectIds, extraMatch = {}) {
  if (!adminObjectIds.length) return new Map();
  const rows = await Model.aggregate([
    { $match: { ...extraMatch, [field]: { $in: adminObjectIds } } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

/** Attach per-organization workspace, party, lot, and party-user login counts to admin rows. */
async function attachOrganizationStats(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const adminObjectIds = rows.map((r) => toObjectId(r._id));

  const [workspaceMap, partyMap, lotMap, partyUserRows] = await Promise.all([
    countByField(BusinessOwner, "userId", adminObjectIds),
    countByField(Party, "userId", adminObjectIds),
    countByField(GhausiaLot, "userId", adminObjectIds),
    User.aggregate([
      {
        $match: {
          role: "party",
          $or: [
            { ownerId: { $in: adminObjectIds } },
            { pendingForAdminId: { $in: adminObjectIds } },
          ],
        },
      },
      {
        $group: {
          _id: { $ifNull: ["$ownerId", "$pendingForAdminId"] },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const partyUserMap = new Map(
    partyUserRows.map((r) => [String(r._id), r.count]),
  );

  return rows.map((row) => {
    const id = String(row._id);
    return {
      ...row,
      stats: {
        workspaces: workspaceMap.get(id) || 0,
        parties: partyMap.get(id) || 0,
        lots: lotMap.get(id) || 0,
        partyUsers: partyUserMap.get(id) || 0,
      },
    };
  });
}

/** Load an organization admin account (`role: "admin"`) or send a 404 response. */
async function findOrgAdminOr404(id, res) {
  const user = await User.findById(id).select(SAFE_USER_PROJECTION);
  if (!user || user.role !== "admin") {
    res.status(404).json({ message: "Administrator account not found" });
    return null;
  }
  return user;
}

/** Load a party login account (`role: "party"`) or send a 404 response. */
async function findPartyUserOr404(id, res) {
  const user = await User.findById(id).select(SAFE_USER_PROJECTION);
  if (!user || user.role !== "party") {
    res.status(404).json({ message: "Party user account not found" });
    return null;
  }
  return user;
}

/** Mark an admin approved, clear rejection/disable metadata, and bust auth cache. */
async function activateOrgAdmin(user, actorId) {
  user.status = "approved";
  user.ownerId = user._id;
  user.approvedBy = user.approvedBy || actorId;
  user.approvedAt = user.approvedAt || new Date();
  user.rejectedAt = null;
  user.disabledAt = null;
  user.disabledReason = "";
  user.pendingForAdminId = null;
  await user.save({ validateBeforeSave: false });
  await user.populate("approvedBy", "name email");
  invalidateAuthUserCache(user._id);
  clearCache("bootstrap");
  return user;
}

/** All org admins (every status) with organization resource counts. */
async function listAllOrganizationAdmins(req, res) {
  try {
    const filter = { role: "admin" };
    const pagination = parsePaginationQuery(req);
    const sort = { createdAt: -1 };
    if (pagination.paginate) {
      const [rows, total] = await Promise.all([
        User.find(filter)
          .sort(sort)
          .select(SAFE_USER_PROJECTION)
          .populate("approvedBy", "name email")
          .skip(pagination.skip)
          .limit(pagination.limit)
          .lean(),
        User.countDocuments(filter),
      ]);
      const enriched = await attachOrganizationStats(rows);
      return paginatedJson(
        res,
        enriched,
        total,
        pagination.page,
        pagination.limit,
      );
    }
    const rows = await User.find(filter)
      .sort(sort)
      .select(SAFE_USER_PROJECTION)
      .populate("approvedBy", "name email")
      .lean();
    const enriched = await attachOrganizationStats(rows);
    return res.json(enriched);
  } catch (error) {
    res.status(500).json({
      message: "Error loading organization administrators",
      error: error.message,
    });
  }
}

router.get("/organization-admins", listAllOrganizationAdmins);
/** @deprecated Use /organization-admins; kept for older clients — same payload. */
router.get("/pending-admins", listAllOrganizationAdmins);

router.patch("/admins/:id/approve", async (req, res) => {
  try {
    const user = await findOrgAdminOr404(req.params.id, res);
    if (!user) return;
    if (user.status !== "pending" && user.status !== "rejected") {
      return res.status(400).json({
        message: "Only pending or rejected administrators can be approved",
      });
    }
    user.approvedBy = req.user._id;
    user.approvedAt = new Date();
    await activateOrgAdmin(user, req.user._id);
    const [enriched] = await attachOrganizationStats([user.toJSON()]);
    res.json(enriched || user.toJSON());
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error approving administrator", error: error.message });
  }
});

router.patch("/admins/:id/reject", async (req, res) => {
  try {
    const user = await findOrgAdminOr404(req.params.id, res);
    if (!user) return;
    if (user.status !== "pending") {
      return res
        .status(400)
        .json({ message: "Only pending administrator requests can be rejected" });
    }
    user.status = "rejected";
    user.rejectedAt = new Date();
    user.disabledAt = null;
    user.disabledReason = "";
    await user.save({ validateBeforeSave: false });
    invalidateAuthUserCache(user._id);
    clearCache("bootstrap");
    const [enriched] = await attachOrganizationStats([user.toJSON()]);
    res.json(enriched || user.toJSON());
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error rejecting administrator", error: error.message });
  }
});

router.patch("/admins/:id/disable", async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user._id)) {
      return res
        .status(400)
        .json({ message: "Cannot disable your own account" });
    }
    const user = await findOrgAdminOr404(req.params.id, res);
    if (!user) return;
    if (user.status === "disabled") {
      return res
        .status(400)
        .json({ message: "Administrator is already disabled" });
    }
    await applyUserDisable(user, req.body?.reason);
    const orgPartyUsers = await User.find({ role: "party", ownerId: user._id })
      .select("_id")
      .lean();
    for (const pu of orgPartyUsers) {
      invalidateAuthUserCache(pu._id);
      disconnectUserSockets(req.io, pu._id);
    }
    disconnectUserSockets(req.io, user._id);
    await user.populate("approvedBy", "name email");
    const [enriched] = await attachOrganizationStats([user.toJSON()]);
    res.json(enriched || user.toJSON());
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error disabling administrator", error: error.message });
  }
});

router.patch("/admins/:id/enable", async (req, res) => {
  try {
    const user = await findOrgAdminOr404(req.params.id, res);
    if (!user) return;
    if (user.status !== "disabled") {
      return res
        .status(400)
        .json({ message: "Only disabled administrators can be re-enabled" });
    }
    await activateOrgAdmin(user, req.user._id);
    const [enriched] = await attachOrganizationStats([user.toJSON()]);
    res.json(enriched || user.toJSON());
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error enabling administrator", error: error.message });
  }
});

router.delete("/admins/:id", async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user._id)) {
      return res
        .status(400)
        .json({ message: "Cannot delete your own account" });
    }
    const user = await findOrgAdminOr404(req.params.id, res);
    if (!user) return;

    const impact = await getOrganizationImpact(user._id);
    if (impact.requiresEmailConfirmation) {
      const provided = String(req.body?.confirmEmail || "")
        .trim()
        .toLowerCase();
      const expected = String(user.email || "")
        .trim()
        .toLowerCase();
      if (!provided || provided !== expected) {
        return res.status(400).json({
          message:
            "This organization has active data or party logins. Enter the administrator email to confirm permanent deletion.",
          code: "CONFIRM_EMAIL_REQUIRED",
          impact,
        });
      }
    }

    const result = await cascadeDeleteOrganizationAdmin(user);
    disconnectUserSockets(req.io, user._id);
    if (Array.isArray(result.deletedPartyUserIds)) {
      for (const puid of result.deletedPartyUserIds) {
        disconnectUserSockets(req.io, puid);
      }
    }
    res.json({ ...result, impact });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting administrator", error: error.message });
  }
});

/** List all party login accounts across organizations for super-admin oversight. */
router.get("/party-users", async (req, res) => {
  try {
    const filter = { role: "party" };
    const pagination = parsePaginationQuery(req);
    const sort = { createdAt: -1 };
    if (pagination.paginate) {
      const [rows, total] = await Promise.all([
        User.find(filter)
          .sort(sort)
          .select(SAFE_USER_PROJECTION)
          .populate("ownerId", "name email")
          .populate("pendingForAdminId", "name email")
          .populate("approvedBy", "name email")
          .skip(pagination.skip)
          .limit(pagination.limit)
          .lean(),
        User.countDocuments(filter),
      ]);
      return paginatedJson(res, rows, total, pagination.page, pagination.limit);
    }
    const rows = await User.find(filter)
      .sort(sort)
      .select(SAFE_USER_PROJECTION)
      .populate("ownerId", "name email")
      .populate("pendingForAdminId", "name email")
      .populate("approvedBy", "name email")
      .lean();
    return res.json(rows);
  } catch (error) {
    res.status(500).json({
      message: "Error loading party users",
      error: error.message,
    });
  }
});

router.patch("/party-users/:id/disable", async (req, res) => {
  try {
    const user = await findPartyUserOr404(req.params.id, res);
    if (!user) return;
    if (user.status === "disabled") {
      return res
        .status(400)
        .json({ message: "Party user account is already disabled" });
    }
    await applyUserDisable(user, req.body?.reason);
    await user.populate("ownerId pendingForAdminId approvedBy", "name email");
    emitOrgChange(req, "users", { targetUserId: String(user._id) });
    disconnectUserSockets(req.io, user._id);
    res.json(user.toJSON());
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error disabling party user", error: error.message });
  }
});

router.patch("/party-users/:id/enable", async (req, res) => {
  try {
    const user = await findPartyUserOr404(req.params.id, res);
    if (!user) return;
    if (user.status !== "disabled") {
      return res
        .status(400)
        .json({ message: "Only disabled party users can be re-enabled" });
    }
    if (!user.ownerId) {
      return res.status(400).json({
        message:
          "Cannot enable a party user without an assigned organization admin",
      });
    }
    const cleanPartyId = String(user.partyId || "").trim();
    const cleanPartyName = String(user.partyName || "").trim();
    if (!cleanPartyId || cleanPartyName === "Unknown (deleted)") {
      return res.status(400).json({
        message:
          "Cannot enable a party user whose assigned party has been deleted",
      });
    }
    if (mongoose.Types.ObjectId.isValid(cleanPartyId)) {
      const partyExists = await Party.exists({
        _id: cleanPartyId,
        userId: user.ownerId,
        deletedAt: null,
      });
      if (!partyExists) {
        return res.status(400).json({
          message:
            "Cannot enable a party user whose assigned party is deleted or in trash",
        });
      }
    }
    user.status = "approved";
    user.disabledAt = null;
    user.disabledReason = "";
    user.approvedBy = user.approvedBy || req.user._id;
    user.approvedAt = user.approvedAt || new Date();
    await user.save({ validateBeforeSave: false });
    invalidateAuthUserCache(user._id);
    clearCache("bootstrap");
    await user.populate("ownerId pendingForAdminId approvedBy", "name email");
    emitOrgChange(req, "users", { targetUserId: String(user._id) });
    res.json(user.toJSON());
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error enabling party user", error: error.message });
  }
});

/** Safe login-only delete: preserves all business parties, lots, ledger entries, and payments. */
router.delete("/party-users/:id", async (req, res) => {
  try {
    const user = await findPartyUserOr404(req.params.id, res);
    if (!user) return;
    const result = await deletePartyUserLoginOnly(user);
    emitOrgChange(req, "users", { targetUserId: String(user._id) });
    disconnectUserSockets(req.io, user._id);
    res.json(result);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting party user", error: error.message });
  }
});

module.exports = router;
