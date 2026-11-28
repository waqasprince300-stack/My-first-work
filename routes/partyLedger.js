const express = require("express");
const router = express.Router();
const PartyLedger = require("../models/PartyLedger");
const {
  getBusinessOwnerFilter,
  getDataOwnerId,
  getScopedFilter,
  requireAdminUser,
  validateObjectIdParam,
} = require("../utils/access");

router.param("id", validateObjectIdParam);

const stripOwnership = ({
  userId: _userId,
  businessOwnerId: _businessOwnerId,
  _id: _mongoId,
  id: _id,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  ...data
}) => data;

// Get all ledger entries (Admin only — contains admin billAmount totals)
router.get("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const { partyId } = req.query;
    let query = getScopedFilter(req);

    if (partyId) {
      query.partyId = partyId;
    }

    const includeReceipts =
      String(req.query.includeReceipts || "").toLowerCase() === "1" ||
      req.query.includeReceipts === "true";

    let ledgerQuery = PartyLedger.find(query).sort({
      completeDate: -1,
      updatedAt: -1,
    });
    if (!includeReceipts) ledgerQuery = ledgerQuery.select("-receipt");
    const ledger = await ledgerQuery.lean();
    res.json(ledger);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching ledger", error: error.message });
  }
});

// Create ledger entry
router.post("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const entry = new PartyLedger({
      ...stripOwnership(req.body),
      userId: getDataOwnerId(req.user),
      businessOwnerId: req.businessOwnerId,
    });
    const savedEntry = await entry.save();
    res.status(201).json(savedEntry);
  } catch (error) {
    const status =
      error?.code === 11000
        ? 409
        : error?.name === "ValidationError" || error?.name === "CastError"
          ? 400
          : 500;
    res
      .status(status)
      .json({ message: "Error creating ledger entry", error: error.message });
  }
});

// Update ledger entry
router.patch("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const entry = await PartyLedger.findOneAndUpdate(
      {
        _id: req.params.id,
        userId: getDataOwnerId(req.user),
        ...getBusinessOwnerFilter(req),
      },
      stripOwnership(req.body),
      { new: true, runValidators: true },
    );
    if (!entry) {
      return res.status(404).json({ message: "Ledger entry not found" });
    }
    res.json(entry);
  } catch (error) {
    const status =
      error?.code === 11000
        ? 409
        : error?.name === "ValidationError" || error?.name === "CastError"
          ? 400
          : 500;
    res
      .status(status)
      .json({ message: "Error updating ledger entry", error: error.message });
  }
});

module.exports = router;
