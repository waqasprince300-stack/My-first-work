const express = require("express");
const router = express.Router();
const PartyEdit = require("../models/PartyEdit");
const GhausiaLot = require("../models/GhausiaLot");
const {
  getBusinessOwnerFilter,
  getDataOwnerId,
  getOwnerFilter,
  getPartyAllBusinessLotsFilter,
  getPartyAccessibleLotFilter,
  isParty,
  requireAdminUser,
  isTenantAdmin,
} = require("../utils/access");
const { parsePaginationQuery, paginatedJson } = require("../utils/pagination");
const { emitOrgChange } = require("../utils/realtime");
const {
  notifyBillRevisionRequest,
  notifyBillRevisionResolved,
} = require("../utils/lotNotifications");

const stripOwnership = ({ userId: _userId, ...data }) => data;

const PARTY_EDIT_PATCH_FIELDS = [
  "completeDate",
  "partyBillAmount",
  "receipt",
  "lotImages",
  "notes",
  "overrideStatus",
  "pendingRevision",
  "billRevisionRequest",
  "amountChangeNote",
  "allotDate",
];

const pickPartyEditPatch = (body) => {
  const out = {};
  for (const key of PARTY_EDIT_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
};

/** Attach hasReceipt / lotImagesCount without shipping base64 blobs. */
async function attachPartyEditImageMeta(filter, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (rows || []).map((p) => ({ ...p, id: String(p._id || p.id) }));
  }
  const [withReceipt, imageMeta] = await Promise.all([
    PartyEdit.find({
      ...filter,
      receipt: { $exists: true, $nin: ["", null] },
    })
      .select("_id")
      .lean(),
    PartyEdit.aggregate([
      { $match: filter },
      {
        $project: {
          _id: 1,
          lotImagesCount: { $size: { $ifNull: ["$lotImages", []] } },
        },
      },
    ]),
  ]);
  const receiptIds = new Set(withReceipt.map((d) => String(d._id)));
  const countById = new Map(
    imageMeta.map((d) => [String(d._id), Number(d.lotImagesCount) || 0]),
  );
  return rows.map((doc) => {
    const id = String(doc._id || doc.id);
    const lotImagesCount = Array.isArray(doc.lotImages)
      ? doc.lotImages.length
      : countById.get(id) || 0;
    return {
      ...doc,
      id,
      hasReceipt:
        typeof doc.receipt === "string" && doc.receipt.trim() !== ""
          ? true
          : receiptIds.has(id),
      hasLotImages: lotImagesCount > 0,
      lotImagesCount,
    };
  });
}

/** Max lot pictures = number of colors on the lot (minimum 1). */
const lotPicturesMaxFromColors = (colors) => {
  const n = Number(colors);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
};

async function assertLotImagesWithinColorLimit(req, lotId, lotImages) {
  if (lotImages === undefined) return null;
  if (!Array.isArray(lotImages)) {
    return "lotImages must be an array";
  }
  let lot;
  if (isParty(req.user)) {
    lot = await GhausiaLot.findOne(
      getPartyAccessibleLotFilter(req.user, { _id: lotId }),
    )
      .select("colors")
      .lean();
  } else {
    lot = await GhausiaLot.findOne({
      _id: lotId,
      userId: getDataOwnerId(req.user),
    })
      .select("colors")
      .lean();
  }
  if (!lot) return "Lot not found";
  const max = lotPicturesMaxFromColors(lot.colors);
  if (lotImages.length > max) {
    return `This lot allows at most ${max} picture(s) (${max} color(s)).`;
  }
  return null;
}

const getAllowedPartyLotIds = async (req) => {
  if (!isParty(req.user)) return null;
  const lots = await GhausiaLot.find({
    userId: getDataOwnerId(req.user),
    partyId: String(req.user.partyId || ""),
  })
    .select("_id")
    .lean();
  return lots.map((lot) => String(lot._id));
};

// Get all party edits
router.get("/", async (req, res) => {
  try {
    const partyLedgerAll =
      String(req.query.partyScope || "").toLowerCase() === "all" &&
      isParty(req.user);
    let allowedLotIds = null;
    if (partyLedgerAll) {
      const lots = await GhausiaLot.find(
        getPartyAllBusinessLotsFilter(req.user),
      )
        .select("_id")
        .lean();
      allowedLotIds = lots.map((lot) => String(lot._id));
    } else if (isParty(req.user)) {
      allowedLotIds = await getAllowedPartyLotIds(req);
    }

    const allWorkspaces =
      String(req.query.scope || "").toLowerCase() === "all" &&
      isTenantAdmin(req.user);
    const bizFilter =
      allWorkspaces || partyLedgerAll ? {} : getBusinessOwnerFilter(req);

    const filter = {
      ...getOwnerFilter(req),
      ...bizFilter,
      ...(allowedLotIds !== null ? { lotId: { $in: allowedLotIds } } : {}),
    };
    const includeReceipts =
      String(req.query.includeReceipts || "").toLowerCase() === "1" ||
      req.query.includeReceipts === "true";
    const pagination = parsePaginationQuery(req);
    // Base64 images are heavy — excluded unless explicitly requested.
    // includeReceipts = bill only; includeLotImages = lot pictures only (see GET /lot/:id).
    const heavyImageSelect = "-receipt -lotImages";
    let query = PartyEdit.find(filter).sort({ createdAt: -1 });
    if (!includeReceipts) query = query.select(heavyImageSelect);
    else query = query.select("-lotImages");
    if (pagination.paginate) {
      const [rows, total] = await Promise.all([
        PartyEdit.find(filter)
          .sort({ createdAt: -1 })
          .select(includeReceipts ? "-lotImages" : heavyImageSelect)
          .skip(pagination.skip)
          .limit(pagination.limit)
          .lean(),
        PartyEdit.countDocuments(filter),
      ]);
      const withMeta = await attachPartyEditImageMeta(filter, rows);
      return paginatedJson(
        res,
        withMeta,
        total,
        pagination.page,
        pagination.limit,
      );
    }
    const partyEdits = await query.lean();
    res.json(await attachPartyEditImageMeta(filter, partyEdits));
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching party edits", error: error.message });
  }
});

// Get party edit for a single lot (optional receipt / lot pictures for lazy loading)
router.get("/lot/:lotId", async (req, res) => {
  try {
    const lotIdStr = String(req.params.lotId || "").trim();
    const userId = getDataOwnerId(req.user);
    let businessOwnerId = req.businessOwnerId;

    const includeReceipts =
      String(req.query.includeReceipts || "").toLowerCase() === "1" ||
      req.query.includeReceipts === "true";
    const includeLotImages =
      String(req.query.includeLotImages || "").toLowerCase() === "1" ||
      req.query.includeLotImages === "true";

    if (isParty(req.user)) {
      const lot = await GhausiaLot.findOne(
        getPartyAccessibleLotFilter(req.user, { _id: lotIdStr }),
      );
      if (!lot) {
        return res
          .status(404)
          .json({ message: "Lot not found for this party" });
      }
      businessOwnerId = String(lot.businessOwnerId ?? "").trim();
    } else if (isTenantAdmin(req.user)) {
      const queryBiz = String(req.query.businessOwnerId || "").trim();
      if (queryBiz) {
        businessOwnerId = queryBiz;
      } else {
        const lot = await GhausiaLot.findOne({ _id: lotIdStr, userId })
          .select("businessOwnerId")
          .lean();
        if (lot?.businessOwnerId) {
          businessOwnerId = String(lot.businessOwnerId);
        }
      }
    }

    const exclude = [];
    if (!includeReceipts) exclude.push("-receipt");
    if (!includeLotImages) exclude.push("-lotImages");
    const fieldSelect = exclude.length ? exclude.join(" ") : undefined;

    let row = await PartyEdit.findOne({
      lotId: lotIdStr,
      userId,
      businessOwnerId,
    })
      .select(fieldSelect)
      .lean();

    // Both the admin and the party ledger span multiple workspaces, so a businessOwnerId/header
    // mismatch (e.g. legacy rows saved with an empty businessOwnerId) must not hide an existing
    // row. For a party the lot's ownership was already validated above, and `userId` pins the
    // tenant, so this businessOwnerId-agnostic fallback is safe for party and admin alike.
    if (!row) {
      row = await PartyEdit.findOne({ lotId: lotIdStr, userId })
        .select(fieldSelect)
        .lean();
    }

    if (!row) {
      return res.status(404).json({ message: "Party edit not found" });
    }
    const lotImagesCount = Array.isArray(row.lotImages)
      ? row.lotImages.length
      : undefined;
    res.json({
      ...row,
      id: String(row._id),
      ...(lotImagesCount !== undefined
        ? { lotImagesCount, hasLotImages: lotImagesCount > 0 }
        : {}),
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching party edit", error: error.message });
  }
});

// Get single party edit
router.get("/:id", async (req, res) => {
  try {
    const allowedLotIds = await getAllowedPartyLotIds(req);
    const partyEdit = await PartyEdit.findOne({
      _id: req.params.id,
      ...getOwnerFilter(req),
      ...getBusinessOwnerFilter(req),
      ...(allowedLotIds ? { lotId: { $in: allowedLotIds } } : {}),
    });
    if (!partyEdit) {
      return res.status(404).json({ message: "Party edit not found" });
    }
    res.json(partyEdit);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching party edit", error: error.message });
  }
});

// Create party edit
router.post("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const partyEdit = new PartyEdit({
      ...stripOwnership(req.body),
      userId: getDataOwnerId(req.user),
      businessOwnerId: req.businessOwnerId,
    });
    const savedPartyEdit = await partyEdit.save();
    res
      .status(201)
      .json({
        ...savedPartyEdit.toObject(),
        id: savedPartyEdit._id.toString(),
      });
    emitOrgChange(req, "partyEdit", {
      lotId: String(savedPartyEdit.lotId || ""),
    });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error creating party edit", error: error.message });
  }
});

// Update party edit by MongoDB _id
router.patch("/:id", async (req, res) => {
  try {
    const allowedLotIds = await getAllowedPartyLotIds(req);
    const accessFilter = {
      _id: req.params.id,
      ...getOwnerFilter(req),
      ...getBusinessOwnerFilter(req),
      ...(allowedLotIds ? { lotId: { $in: allowedLotIds } } : {}),
    };
    const patch = pickPartyEditPatch(req.body);
    if (Object.prototype.hasOwnProperty.call(patch, "lotImages")) {
      const existing = await PartyEdit.findOne(accessFilter)
        .select("lotId")
        .lean();
      if (!existing) {
        return res.status(404).json({ message: "Party edit not found" });
      }
      const lotImagesError = await assertLotImagesWithinColorLimit(
        req,
        existing.lotId,
        patch.lotImages,
      );
      if (lotImagesError) {
        return res.status(400).json({ message: lotImagesError });
      }
    }
    const partyEdit = await PartyEdit.findOneAndUpdate(
      accessFilter,
      stripOwnership(patch),
      { new: true, runValidators: true },
    );
    if (!partyEdit) {
      return res.status(404).json({ message: "Party edit not found" });
    }
    res.json({ ...partyEdit.toObject(), id: partyEdit._id.toString() });
    emitOrgChange(req, "partyEdit", { lotId: String(partyEdit.lotId || "") });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error updating party edit", error: error.message });
  }
});

// Upsert party edit by lotId
router.put("/lot/:lotId", async (req, res) => {
  try {
    const { lotId } = req.params;
    const userId = getDataOwnerId(req.user);
    let businessOwnerId = req.businessOwnerId;

    if (isParty(req.user)) {
      const lot = await GhausiaLot.findOne(
        getPartyAccessibleLotFilter(req.user, { _id: lotId }),
      );
      if (!lot) {
        return res
          .status(404)
          .json({ message: "Lot not found for this party" });
      }
      businessOwnerId = String(lot.businessOwnerId ?? "").trim();
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "lotImages")) {
      const lotImagesError = await assertLotImagesWithinColorLimit(
        req,
        lotId,
        req.body.lotImages,
      );
      if (lotImagesError) {
        return res.status(400).json({ message: lotImagesError });
      }
    }

    const data = {
      ...stripOwnership(req.body),
      lotId,
      userId,
      businessOwnerId,
    };
    const unset = {};
    if (
      Object.prototype.hasOwnProperty.call(data, "pendingRevision") &&
      data.pendingRevision === null
    ) {
      unset.pendingRevision = "";
      delete data.pendingRevision;
    }
    if (
      Object.prototype.hasOwnProperty.call(data, "billRevisionRequest") &&
      data.billRevisionRequest === null
    ) {
      unset.billRevisionRequest = "";
      delete data.billRevisionRequest;
    }
    const update =
      Object.keys(unset).length > 0 ? { $set: data, $unset: unset } : data;

    let prevBillRev = null;
    if (
      !isParty(req.user) &&
      Object.prototype.hasOwnProperty.call(
        req.body || {},
        "billRevisionRequest",
      )
    ) {
      const existing = await PartyEdit.findOne({
        lotId,
        userId,
        businessOwnerId,
      })
        .select("billRevisionRequest")
        .lean();
      prevBillRev = existing?.billRevisionRequest || null;
      if (!prevBillRev) {
        const fallback = await PartyEdit.findOne({ lotId, userId })
          .select("billRevisionRequest")
          .lean();
        prevBillRev = fallback?.billRevisionRequest || null;
      }
    }

    const partyEdit = await PartyEdit.findOneAndUpdate(
      { lotId, userId, businessOwnerId },
      update,
      { new: true, upsert: true, runValidators: true },
    );
    res.json({ ...partyEdit.toObject(), id: partyEdit._id.toString() });

    const bodyRev = req.body?.billRevisionRequest;
    const isNewPendingBillRev =
      isParty(req.user) &&
      Object.prototype.hasOwnProperty.call(
        req.body || {},
        "billRevisionRequest",
      ) &&
      bodyRev &&
      typeof bodyRev === "object" &&
      String(bodyRev.status || "").toLowerCase() === "pending";

    const loadLotForNotify = async () => {
      try {
        const byOwner = await GhausiaLot.findOne({ _id: lotId, userId }).lean();
        if (byOwner) return byOwner;
      } catch {
        /* ignore */
      }
      try {
        return await GhausiaLot.findById(lotId).lean();
      } catch {
        return null;
      }
    };

    if (isNewPendingBillRev) {
      const lotForNotify = await loadLotForNotify();
      const linkPath = `/party-ledger?lotId=${encodeURIComponent(String(lotId))}&billReview=1`;
      emitOrgChange(req, "partyEdit", {
        lotId: String(lotId),
        action: "bill_revision_request",
        linkPath,
      });
      if (lotForNotify) {
        void notifyBillRevisionRequest({
          lot: lotForNotify,
          ownerId: userId,
          fromAmount: bodyRev.fromAmount,
          toAmount: bodyRev.toAmount,
          reason: bodyRev.reason,
        });
      }
    } else if (
      !isParty(req.user) &&
      Object.prototype.hasOwnProperty.call(
        req.body || {},
        "billRevisionRequest",
      )
    ) {
      const approved = bodyRev === null && prevBillRev;
      const rejected =
        bodyRev &&
        typeof bodyRev === "object" &&
        String(bodyRev.status || "").toLowerCase() === "rejected";
      if (approved || rejected) {
        const lotForNotify = await loadLotForNotify();
        const linkPath = `/party-ledger?lotId=${encodeURIComponent(String(lotId))}`;
        const action = approved
          ? "bill_revision_approved"
          : "bill_revision_rejected";
        emitOrgChange(req, "partyEdit", {
          lotId: String(lotId),
          action,
          linkPath,
        });
        if (lotForNotify) {
          void notifyBillRevisionResolved({
            lot: lotForNotify,
            ownerId: userId,
            approved: Boolean(approved),
            fromAmount: prevBillRev?.fromAmount ?? bodyRev?.fromAmount,
            toAmount: prevBillRev?.toAmount ?? bodyRev?.toAmount,
            note: bodyRev?.rejectionNote,
          });
        }
      } else {
        emitOrgChange(req, "partyEdit", { lotId: String(lotId) });
      }
    } else {
      emitOrgChange(req, "partyEdit", { lotId: String(lotId) });
    }
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error upserting party edit", error: error.message });
  }
});

// Delete party edit
router.delete("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const partyEdit = await PartyEdit.findOneAndDelete({
      _id: req.params.id,
      userId: getDataOwnerId(req.user),
      businessOwnerId: req.businessOwnerId,
    });
    if (!partyEdit) {
      return res.status(404).json({ message: "Party edit not found" });
    }
    res.json({ message: "Party edit deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting party edit", error: error.message });
  }
});

module.exports = router;
