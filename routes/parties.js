const express = require("express");
const router = express.Router();
const Party = require("../models/Party");
const GhausiaLot = require("../models/GhausiaLot");
const Payment = require("../models/Payment");
const PartyEdit = require("../models/PartyEdit");
const PartyLedger = require("../models/PartyLedger");
const {
  getDataOwnerId,
  isParty,
  requireAdminUser,
} = require("../utils/access");
const { parsePaginationQuery, paginatedJson } = require("../utils/pagination");

/** Ignore client-sent tenant fields; server sets userId and businessOwnerId. */
const stripOwnership = ({ userId: _userId, businessOwnerId: _businessOwnerId, ...data }) => data;

// Get all parties
router.get("/", async (req, res) => {
  try {
    const filter = isParty(req.user)
      ? { userId: getDataOwnerId(req.user), _id: req.user.partyId, deletedAt: null }
      : { userId: getDataOwnerId(req.user), deletedAt: null };
    const pagination = parsePaginationQuery(req, 8);
    const sort = { name: 1 };
    if (pagination.paginate) {
      const [items, total] = await Promise.all([
        Party.find(filter)
          .sort(sort)
          .skip(pagination.skip)
          .limit(pagination.limit)
          .lean(),
        Party.countDocuments(filter),
      ]);
      return paginatedJson(
        res,
        items,
        total,
        pagination.page,
        pagination.limit,
      );
    }

    const parties = await Party.find(filter).sort(sort).lean();
    res.json(parties);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching parties", error: error.message });
  }
});

// Get deleted parties (trash)
router.get("/trash", async (req, res) => {
  try {
    const filter = isParty(req.user)
      ? { userId: getDataOwnerId(req.user), _id: req.user.partyId, deletedAt: { $ne: null } }
      : { userId: getDataOwnerId(req.user), deletedAt: { $ne: null } };
    
    const parties = await Party.find(filter).sort({ deletedAt: -1 }).lean();
    res.json(parties);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching trashed parties", error: error.message });
  }
});

// Get single party
router.get("/:id", async (req, res) => {
  try {
    const filter = isParty(req.user)
      ? { userId: getDataOwnerId(req.user), _id: req.user.partyId, deletedAt: null }
      : { userId: getDataOwnerId(req.user), _id: req.params.id, deletedAt: null };
    const party = await Party.findOne(filter).lean();
    if (!party) {
      return res.status(404).json({ message: "Party not found" });
    }
    res.json(party);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching party", error: error.message });
  }
});

// Create party
router.post("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const adminUserId = getDataOwnerId(req.user);
    const bizId =
      req.businessOwnerId != null && String(req.businessOwnerId).trim() !== ""
        ? req.businessOwnerId
        : null;
    const party = new Party({
      ...stripOwnership(req.body),
      userId: adminUserId,
      ...(bizId ? { businessOwnerId: bizId } : { businessOwnerId: null }),
    });
    const savedParty = await party.save();
    res.status(201).json(savedParty);
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error creating party", error: error.message });
  }
});

// Update party
router.patch("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const party = await Party.findOneAndUpdate(
      { _id: req.params.id, userId: getDataOwnerId(req.user) },
      stripOwnership(req.body),
      { new: true, runValidators: true },
    );
    if (!party) {
      return res.status(404).json({ message: "Party not found" });
    }
    res.json(party);
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error updating party", error: error.message });
  }
});

// Soft-delete party (move to trash)
router.delete("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const party = await Party.findOne({
      _id: req.params.id,
      userId,
    });
    if (!party) {
      return res.status(404).json({ message: "Party not found" });
    }
    if (party.deletedAt) {
      return res.status(400).json({ message: "Party is already in trash" });
    }

    // Soft delete: set deletedAt and append suffix to name to avoid unique constraint issues if recreated
    const deletedSuffix = ` (Deleted ${Date.now()})`;
    party.deletedAt = new Date();
    party.name = party.name + deletedSuffix;
    await party.save();

    const User = require("../models/User");
    const { invalidateAuthUserCache } = require("../middleware/auth");

    const usersToDisable = await User.find({ role: "party", ownerId: userId, partyId: String(party._id), status: { $in: ["approved", "pending"] } }).select("_id").lean();

    await User.updateMany(
      { _id: { $in: usersToDisable.map(u => u._id) } },
      { $set: { status: "disabled", disabledAt: new Date(), disabledReason: "party_deleted" } }
    ).catch(err => console.error("Error disabling users on soft delete:", err));

    for (const u of usersToDisable) {
      invalidateAuthUserCache(u._id);
    }

    res.json({ message: "Party moved to trash successfully", party });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error moving party to trash", error: error.message });
  }
});

// Restore party from trash
router.post("/:id/restore", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const party = await Party.findOne({
      _id: req.params.id,
      userId,
      deletedAt: { $ne: null }
    });
    
    if (!party) {
      return res.status(404).json({ message: "Party not found in trash" });
    }

    party.deletedAt = null;
    party.name = party.name.replace(/ \(Deleted \d+\)$/, "");
    await party.save();

    const User = require("../models/User");
    const { invalidateAuthUserCache } = require("../middleware/auth");

    const usersToEnable = await User.find({ role: "party", ownerId: userId, partyId: String(party._id), status: "disabled", disabledReason: "party_deleted" }).select("_id").lean();

    await User.updateMany(
      { _id: { $in: usersToEnable.map(u => u._id) } },
      { $set: { status: "approved", disabledAt: null, disabledReason: "" } }
    ).catch(err => console.error("Error enabling users on restore:", err));

    for (const u of usersToEnable) {
      invalidateAuthUserCache(u._id);
    }

    res.json({ message: "Party restored successfully", party });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Cannot restore: A party with this name already exists in the active list." });
    }
    res
      .status(500)
      .json({ message: "Error restoring party", error: error.message });
  }
});

// Delete party permanently
router.delete("/:id/permanent", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const party = await Party.findOneAndDelete({
      _id: req.params.id,
      userId,
    });
    if (!party) {
      return res.status(404).json({ message: "Party not found" });
    }

    // Cascade: clear party references from associated records so they don't become orphaned
    const partyId = String(party._id);
    // Strip out the (Deleted timestamp) suffix if it exists for cascading text fields
    const partyName = (party.name || "").replace(/ \(Deleted \d+\)$/, "");
    const clearPartyRef = { $set: { partyId: "", partyName: "Unknown (deleted)" } };
    const partyFilter = { userId, $or: [{ partyId }, ...(partyName ? [{ partyName }] : [])] };
    
    // Find lots belonging to this party BEFORE clearing their partyId
    const lotsOfParty = await GhausiaLot.find(partyFilter).select("_id").lean();
    const lotIds = lotsOfParty.map(l => String(l._id));

    const User = require("../models/User");
    const { invalidateAuthUserCache } = require("../middleware/auth");
    const userFilter = { role: "party", ownerId: userId, $or: [{ partyId }, ...(partyName ? [{ partyName }] : [])] };
    const usersToDisable = await User.find(userFilter).select("_id").lean();

    await Promise.all([
      GhausiaLot.updateMany(partyFilter, clearPartyRef),
      Payment.updateMany({ userId, $or: [{ partyId }, ...(partyName ? [{ party: partyName }] : [])] }, { $set: { partyId: "", party: "Unknown (deleted)" } }),
      PartyEdit.deleteMany({ userId, lotId: { $in: lotIds } }),
      PartyLedger.deleteMany(partyFilter),
      User.updateMany(userFilter, { $set: { status: "disabled", disabledAt: new Date(), partyId: "", partyName: "Unknown (deleted)" } }),
    ]).catch((err) => console.error("Party cascade cleanup error:", err));

    for (const u of usersToDisable) {
      invalidateAuthUserCache(u._id);
    }

    res.json({ message: "Party deleted permanently" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error permanently deleting party", error: error.message });
  }
});

module.exports = router;
