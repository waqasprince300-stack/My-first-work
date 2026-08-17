const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const Announcement = require("../models/Announcement");
const { resolveBusinessOwner, getDataOwnerId, isParty, isTenantAdmin } = require("../utils/access");
const { emitOrgChange } = require("../utils/realtime");
const Party = require("../models/Party");
const { calculatePartyMotivation, calculateAllPartiesMotivation } = require("../utils/partyMotivation");

const serialize = (doc) => {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    ...o,
    id: String(o._id),
  };
};

/** GET /notifications — newest first, max 50 */
router.get("/", async (req, res) => {
  try {
    const userId = req.user._id;
    const rows = await Notification.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(rows.map((r) => ({ ...r, id: String(r._id) })));
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching notifications", error: error.message });
  }
});

/** GET /notifications/unread-count */
router.get("/unread-count", async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      userId: req.user._id,
      readAt: null,
    });
    res.json({ count });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error counting notifications", error: error.message });
  }
});

/** PATCH /notifications/:id/read */
router.patch("/:id/read", async (req, res) => {
  try {
    const row = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { readAt: new Date() } },
      { new: true },
    );
    if (!row) {
      return res.status(404).json({ message: "Notification not found" });
    }
    res.json(serialize(row));
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error updating notification", error: error.message });
  }
});

/** POST /notifications/read-all */
router.post("/read-all", async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user._id, readAt: null },
      { $set: { readAt: new Date() } },
    );
    res.json({ updated: result.modifiedCount || 0 });
  } catch (error) {
    res
      .status(400)
      .json({
        message: "Error marking notifications read",
        error: error.message,
      });
  }
});

/** POST /notifications/subscribe */
router.post("/subscribe", async (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ message: "Invalid subscription" });
    }

    const User = require("../models/User");
    const user = await User.findById(req.user._id).select("+pushSubscriptions");
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if subscription already exists
    const exists = user.pushSubscriptions.some(
      (sub) => sub.endpoint === subscription.endpoint
    );

    if (!exists) {
      user.pushSubscriptions.push(subscription);
      await user.save();
    }

    res.status(201).json({ message: "Subscribed successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error subscribing", error: error.message });
  }
});

/** POST /notifications/broadcast (Admin only) */
router.post("/broadcast", async (req, res) => {
  try {
    if (!isTenantAdmin(req.user)) {
      return res.status(403).json({ message: "Only admins can create broadcasts" });
    }
    const { title, body, severity, targetPartyId, durationHours } = req.body;
    const ownerId = req.user.ownerId || req.user._id;

    if (!title) {
      return res.status(400).json({ message: "Title is required" });
    }

    let expiresAt = null;
    if (durationHours && Number(durationHours) > 0) {
      expiresAt = new Date(Date.now() + Number(durationHours) * 60 * 60 * 1000);
    }

    // Stop previous active broadcasts for this org
    await Announcement.updateMany(
      { ownerId, isActive: true },
      { $set: { isActive: false } }
    );

    const announcement = new Announcement({
      ownerId,
      title,
      body,
      severity: severity || "info",
      targetPartyId: targetPartyId || "all",
      expiresAt,
    });

    await announcement.save();

    // Broadcast via socket to everyone in the org room
    emitOrgChange(req, "broadcast", {
      action: "admin_broadcast_start",
      ...serialize(announcement)
    });

    res.status(201).json(serialize(announcement));
  } catch (error) {
    res.status(500).json({ message: "Error creating broadcast", error: error.message });
  }
});

/** GET /notifications/active-broadcasts */
router.get("/active-broadcasts", async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user._id;
    // User might be a party, check if they are the target
    const partyId = req.user.partyId || null;
    
    // Find active announcements for this org
    const query = {
      ownerId,
      isActive: true,
    };

    const timeCondition = {
      $or: [
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } }
      ]
    };

    if (partyId) {
      query.$and = [
        timeCondition,
        {
          $or: [
            { targetPartyId: "all" },
            { targetPartyId: String(partyId) }
          ]
        }
      ];
    } else {
      query.$or = timeCondition.$or;
    }

    const active = await Announcement.find(query).sort({ createdAt: -1 }).lean();
    res.json(active.map(serialize));
  } catch (error) {
    res.status(500).json({ message: "Error fetching broadcasts", error: error.message });
  }
});

/** PUT /notifications/broadcast/:id/stop (Admin only) */
router.put("/broadcast/:id/stop", async (req, res) => {
  try {
    if (!isTenantAdmin(req.user)) {
      return res.status(403).json({ message: "Only admins can stop broadcasts" });
    }
    const ownerId = req.user.ownerId || req.user._id;
    const announcement = await Announcement.findOneAndUpdate(
      { _id: req.params.id, ownerId },
      { isActive: false },
      { new: true }
    );

    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    emitOrgChange(req, "broadcast", {
      action: "admin_broadcast_stop",
      id: announcement.id
    });

    res.json(serialize(announcement));
  } catch (error) {
    res.status(500).json({ message: "Error stopping broadcast", error: error.message });
  }
});

/** GET /notifications/party-motivation (Party user only — private performance insights) */
router.get("/party-motivation", async (req, res) => {
  try {
    if (!isParty(req.user)) {
      return res.status(403).json({ message: "Only party users can access motivation insights" });
    }
    const ownerId = getDataOwnerId(req.user);
    const partyId = req.user.partyId || "";
    const partyName = req.user.partyName || "";

    const result = await calculatePartyMotivation({ partyId: String(partyId), partyName, ownerId });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Error calculating motivation", error: error.message });
  }
});

/** GET /notifications/all-party-motivation (Admin only — all parties performance overview) */
router.get("/all-party-motivation", async (req, res) => {
  try {
    if (!isTenantAdmin(req.user)) {
      return res.status(403).json({ message: "Admin only" });
    }
    const ownerId = getDataOwnerId(req.user);
    const parties = await Party.find({ userId: ownerId }).select("name").lean();
    const results = await calculateAllPartiesMotivation({ ownerId, parties });
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: "Error calculating party insights", error: error.message });
  }
});

module.exports = router;
