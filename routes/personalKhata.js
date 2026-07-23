const express = require("express");
const PersonalKhata = require("../models/PersonalKhata");
const authenticate = require("../middleware/auth");
const { requireApproved } = require("../middleware/auth");

const router = express.Router();

const defaultKhataState = () => {
  const firstId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  return {
    businesses: [
      {
        id: firstId,
        name: "Main business",
        createdAt: new Date().toISOString(),
      },
    ],
    activeBusinessId: firstId,
    contacts: [],
    entries: [],
  };
};

const sanitizeKhataPayload = (body = {}) => {
  const businesses = Array.isArray(body.businesses) ? body.businesses : [];
  const contacts = Array.isArray(body.contacts) ? body.contacts : [];
  const entries = Array.isArray(body.entries) ? body.entries : [];
  let activeBusinessId = String(body.activeBusinessId || "").trim();

  const normalizedBusinesses = businesses.length
    ? businesses
    : defaultKhataState().businesses;

  if (
    !activeBusinessId ||
    !normalizedBusinesses.some((b) => b.id === activeBusinessId)
  ) {
    activeBusinessId = normalizedBusinesses[0].id;
  }

  return {
    businesses: normalizedBusinesses,
    activeBusinessId,
    contacts,
    entries,
  };
};

const toResponse = (doc) => ({
  businesses: doc.businesses,
  activeBusinessId: doc.activeBusinessId,
  contacts: doc.contacts,
  entries: doc.entries,
  updatedAt: doc.updatedAt,
});

router.get("/", authenticate, requireApproved, async (req, res) => {
  try {
    // Every approved account (admin, party, personal_khata) gets its own
    // server-synced Personal Khata, keyed by user id.
    let doc = await PersonalKhata.findOne({ userId: req.user._id });

    if (!doc) {
      const initial = defaultKhataState();
      doc = await PersonalKhata.create({
        userId: req.user._id,
        ...initial,
      });
    }

    res.json(toResponse(doc));
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error loading Personal Khata", error: error.message });
  }
});

router.put("/", authenticate, requireApproved, async (req, res) => {
  try {
    const payload = sanitizeKhataPayload(req.body);

    const doc = await PersonalKhata.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: payload,
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );

    res.json(toResponse(doc));
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error saving Personal Khata", error: error.message });
  }
});

module.exports = router;
