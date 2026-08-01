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
      ? { userId: getDataOwnerId(req.user), _id: req.user.partyId }
      : { userId: getDataOwnerId(req.user) };
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

// Get single party
router.get("/:id", async (req, res) => {
  try {
    const filter = isParty(req.user)
      ? { userId: getDataOwnerId(req.user), _id: req.user.partyId }
      : { userId: getDataOwnerId(req.user), _id: req.params.id };
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

// Delete party
router.delete("/:id", async (req, res) => {
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
    const partyName = party.name || "";
    const clearPartyRef = { $set: { partyId: "", partyName: "Unknown (deleted)" } };
    const partyFilter = { userId, $or: [{ partyId }, ...(partyName ? [{ partyName }] : [])] };
    await Promise.all([
      GhausiaLot.updateMany(partyFilter, clearPartyRef),
      Payment.updateMany({ userId, $or: [{ partyId }, ...(partyName ? [{ party: partyName }] : [])] }, { $set: { partyId: "", party: "Unknown (deleted)" } }),
      PartyEdit.deleteMany({ userId, lotId: { $in: (await GhausiaLot.find({ userId, partyId: "" }).select("_id").lean()).map(l => String(l._id)) } }).catch(() => {}),
      PartyLedger.updateMany({ userId, partyId }, clearPartyRef),
    ]).catch((err) => console.error("Party cascade cleanup error:", err));

    res.json({ message: "Party deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting party", error: error.message });
  }
});

module.exports = router;
