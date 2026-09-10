const express = require("express");
const mongoose = require("mongoose");
const BusinessOwner = require("../models/BusinessOwner");
const PartyEdit = require("../models/PartyEdit");
const PartyLedger = require("../models/PartyLedger");
const Payment = require("../models/Payment");
const GhausiaLot = require("../models/GhausiaLot");
const Party = require("../models/Party");
const Collection = require("../models/Collection");
const RateCalculation = require("../models/RateCalculation");
const SavedDesign = require("../models/SavedDesign");
const User = require("../models/User");
const { getDataOwnerId, requireAdminUser } = require("../utils/access");
const { clearCache } = require("../utils/requestCache");

const router = express.Router();

const normalize = (doc) => ({ ...doc.toObject(), id: String(doc._id) });

router.get("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const owners = await BusinessOwner.find({
      userId: getDataOwnerId(req.user),
      status: "active",
      deletedAt: null,
    })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean();
    res.json(owners.map((doc) => ({ ...doc, id: String(doc._id) })));
  } catch (error) {
    res
      .status(500)
      .json({
        message: "Error fetching business owners",
        error: error.message,
      });
  }
});

// Get deleted business owners (trash)
router.get("/trash", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const owners = await BusinessOwner.find({
      userId: getDataOwnerId(req.user),
      deletedAt: { $ne: null },
    })
      .sort({ deletedAt: -1 })
      .lean();
    res.json(owners.map((doc) => ({ ...doc, id: String(doc._id) })));
  } catch (error) {
    res
      .status(500)
      .json({
        message: "Error fetching trashed business owners",
        error: error.message,
      });
  }
});

router.post("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const name = String(req.body.name || "").trim();

    if (!name) {
      return res
        .status(400)
        .json({ message: "Business owner name is required" });
    }

    const owner = await BusinessOwner.create({
      userId: getDataOwnerId(req.user),
      name,
      phone: String(req.body.phone || "").trim(),
      address: String(req.body.address || "").trim(),
      isDefault: false,
    });

    clearCache("businessOwner");
    res.status(201).json(normalize(owner));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Business owner already exists" });
    }
    res
      .status(400)
      .json({ message: "Error creating business owner", error: error.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const owner = await BusinessOwner.findOneAndUpdate(
      { _id: req.params.id, userId: getDataOwnerId(req.user), deletedAt: null },
      {
        name: String(req.body.name || "").trim(),
        phone: String(req.body.phone || "").trim(),
        address: String(req.body.address || "").trim(),
      },
      { new: true, runValidators: true },
    );

    if (!owner) {
      return res.status(404).json({ message: "Business owner not found" });
    }

    clearCache("businessOwner");
    res.json(normalize(owner));
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error updating business owner", error: error.message });
  }
});

/** Soft-delete workspace (move to trash). */
router.delete("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const rawId = String(req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      return res.status(400).json({ message: "Invalid workspace id" });
    }

    const uid = getDataOwnerId(req.user);
    const owner = await BusinessOwner.findOne({
      _id: rawId,
      userId: uid,
    });

    if (!owner) {
      return res.status(404).json({ message: "Business owner not found" });
    }
    if (owner.deletedAt) {
      return res.status(400).json({ message: "Workspace is already in trash" });
    }
    if (owner.isDefault) {
      return res.status(400).json({ message: "Cannot delete the default workspace. Set another workspace as default first." });
    }

    // Soft delete
    const deletedSuffix = ` (Deleted ${Date.now()})`;
    owner.deletedAt = new Date();
    owner.name = owner.name + deletedSuffix;
    await owner.save();

    clearCache("businessOwner");

    const User = require("../models/User");
    const { invalidateAuthUserCache } = require("../middleware/auth");

    // Disable ONLY users who are currently approved or pending, so we don't overwrite genuinely disabled users.
    const usersToDisable = await User.find({ role: "party", ownerId: uid, businessOwnerId: String(owner._id), status: { $in: ["approved", "pending"] } }).select("_id").lean();

    await User.updateMany(
      { _id: { $in: usersToDisable.map(u => u._id) } },
      { $set: { status: "disabled", disabledAt: new Date(), disabledReason: "workspace_deleted" } }
    ).catch(err => console.error("Error disabling users on soft delete:", err));

    for (const u of usersToDisable) {
      invalidateAuthUserCache(u._id);
    }

    return res.status(204).send();
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error moving business owner to trash", error: error.message });
  }
});

/** Restore workspace from trash. */
router.post("/:id/restore", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const uid = getDataOwnerId(req.user);
    const owner = await BusinessOwner.findOne({
      _id: req.params.id,
      userId: uid,
      deletedAt: { $ne: null },
    });

    if (!owner) {
      return res.status(404).json({ message: "Workspace not found in trash" });
    }

    owner.deletedAt = null;
    owner.name = owner.name.replace(/ \(Deleted \d+\)$/, "");
    await owner.save();

    clearCache("businessOwner");

    const User = require("../models/User");
    const { invalidateAuthUserCache } = require("../middleware/auth");

    // Re-enable ONLY users who were disabled BECAUSE of the workspace deletion.
    const usersToEnable = await User.find({ role: "party", ownerId: uid, businessOwnerId: String(owner._id), status: "disabled", disabledReason: "workspace_deleted" }).select("_id").lean();

    await User.updateMany(
      { _id: { $in: usersToEnable.map(u => u._id) } },
      { $set: { status: "approved", disabledAt: null, disabledReason: "" } }
    ).catch(err => console.error("Error enabling users on restore:", err));

    for (const u of usersToEnable) {
      invalidateAuthUserCache(u._id);
    }

    res.json(normalize(owner));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Cannot restore: A workspace with this name already exists." });
    }
    res
      .status(500)
      .json({ message: "Error restoring workspace", error: error.message });
  }
});

/** DELETE workspace permanently and scoped data. Requires ?force=true if related rows exist. */
router.delete("/:id/permanent", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const rawId = String(req.params.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      return res.status(400).json({ message: "Invalid workspace id" });
    }

    const uid = getDataOwnerId(req.user);
    const owner = await BusinessOwner.findOne({
      _id: rawId,
      userId: uid,
      deletedAt: { $ne: null },
    });

    if (!owner) {
      return res.status(404).json({ message: "Business owner not found" });
    }

    const bid = owner._id;
    const workspaceFilter = { userId: uid, businessOwnerId: bid };
    const force = req.query.force === "true" || req.query.force === "1";

    const countWorkspaceData = async () => {
      const [
        partyEdits,
        partyLedger,
        payments,
        ghausiaLots,
        parties,
        collections,
        rateCalculations,
        savedDesigns,
        partyUsers,
      ] = await Promise.all([
        PartyEdit.countDocuments(workspaceFilter),
        PartyLedger.countDocuments(workspaceFilter),
        Payment.countDocuments(workspaceFilter),
        GhausiaLot.countDocuments(workspaceFilter),
        Party.countDocuments(workspaceFilter),
        Collection.countDocuments(workspaceFilter),
        RateCalculation.countDocuments(workspaceFilter),
        SavedDesign.countDocuments(workspaceFilter),
        User.countDocuments({
          role: "party",
          ownerId: uid,
          businessOwnerId: String(bid),
        }),
      ]);
      return {
        partyEdits,
        partyLedger,
        payments,
        ghausiaLots,
        parties,
        collections,
        rateCalculations,
        savedDesigns,
        partyUsers,
      };
    };

    const counts = await countWorkspaceData();
    const totalRelated = Object.values(counts).reduce((a, n) => a + n, 0);

    if (!force && totalRelated > 0) {
      return res.status(409).json({
        message:
          "This workspace has data. Repeat the request with ?force=true to permanently delete the workspace and remove all related records.",
        counts,
      });
    }

    await Promise.all([
      PartyEdit.deleteMany(workspaceFilter),
      PartyLedger.deleteMany(workspaceFilter),
      Payment.deleteMany(workspaceFilter),
      GhausiaLot.deleteMany(workspaceFilter),
      Party.deleteMany(workspaceFilter),
      Party.updateMany(
        { userId: uid },
        { $pull: { workspaceOverrides: { businessOwnerId: String(bid) } } }
      ),
      Collection.deleteMany(workspaceFilter),
      RateCalculation.deleteMany(workspaceFilter),
      SavedDesign.deleteMany(workspaceFilter),
    ]);

    const userFilter = { role: "party", ownerId: uid, businessOwnerId: String(bid) };
    const usersToDisable = await User.find(userFilter).select("_id").lean();

    await User.updateMany(
      userFilter,
      {
        $set: {
          status: "disabled",
          disabledAt: new Date(),
          disabledReason: "workspace_permanent_deleted",
          partyId: "",
          partyName: "",
          businessOwnerId: "",
        },
      },
    );

    const { invalidateAuthUserCache } = require("../middleware/auth");
    for (const u of usersToDisable) {
      invalidateAuthUserCache(u._id);
    }

    await BusinessOwner.findByIdAndDelete(bid);
    clearCache("businessOwner");
    return res.status(204).send();
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting business owner permanently", error: error.message });
  }
});

module.exports = router;
