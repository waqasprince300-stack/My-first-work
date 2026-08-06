const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");

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

module.exports = router;
