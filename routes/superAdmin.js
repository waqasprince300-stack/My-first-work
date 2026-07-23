const express = require("express");
const User = require("../models/User");
const { parsePaginationQuery, paginatedJson } = require("../utils/pagination");

const router = express.Router();

/** All org admins (every status) — audit log; approved rows are not removed. */
async function listAllOrganizationAdmins(req, res) {
  try {
    const filter = { role: "admin" };
    const pagination = parsePaginationQuery(req);
    const sort = { createdAt: -1 };
    const projection = "-password -passwordResetToken -passwordResetExpires";
    if (pagination.paginate) {
      const [rows, total] = await Promise.all([
        User.find(filter)
          .sort(sort)
          .select(projection)
          .populate("approvedBy", "name email")
          .skip(pagination.skip)
          .limit(pagination.limit)
          .lean(),
        User.countDocuments(filter),
      ]);
      return paginatedJson(res, rows, total, pagination.page, pagination.limit);
    }

    const admins = await User.find(filter)
      .sort(sort)
      .select(projection)
      .populate("approvedBy", "name email")
      .lean();

    res.json(admins);
  } catch (error) {
    res
      .status(500)
      .json({
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
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (String(user._id) === String(req.user._id)) {
      return res
        .status(400)
        .json({ message: "You cannot approve your own account here" });
    }

    if (user.role !== "admin" || user.status !== "pending") {
      return res
        .status(400)
        .json({
          message:
            "This action only applies to pending organization administrators",
        });
    }

    user.status = "approved";
    user.ownerId = user._id;
    user.approvedBy = req.user._id;
    user.approvedAt = new Date();
    user.rejectedAt = null;
    user.disabledAt = null;
    user.pendingForAdminId = null;
    await user.save({ validateBeforeSave: false });

    res.json(user.toJSON());
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error approving administrator", error: error.message });
  }
});

router.patch("/admins/:id/reject", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (String(user._id) === String(req.user._id)) {
      return res
        .status(400)
        .json({ message: "You cannot reject your own account" });
    }

    if (user.role !== "admin" || user.status !== "pending") {
      return res
        .status(400)
        .json({
          message:
            "This action only applies to pending organization administrators",
        });
    }

    user.status = "rejected";
    user.rejectedAt = new Date();
    user.disabledAt = null;
    await user.save({ validateBeforeSave: false });

    res.json(user.toJSON());
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error rejecting administrator", error: error.message });
  }
});

module.exports = router;
