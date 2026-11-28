const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const GhausiaLot = require("../models/GhausiaLot");
const OwnerBill = require("../models/OwnerBill");
const Party = require("../models/Party");
const PartyLedger = require("../models/PartyLedger");
const PartyEdit = require("../models/PartyEdit");
const Payment = require("../models/Payment");
const Notification = require("../models/Notification");
const {
  getDataOwnerId,
  getScopedFilter,
  getPartyAllBusinessLotsFilter,
  getPartyAccessibleLotFilter,
  escapeRegexString,
  isParty,
  requireAdminUser,
  isTenantAdmin,
  resolvePartyWorkspaceLabel,
  stripPrivateLotFieldsForParty,
  toObjectId,
  validateObjectIdParam,
} = require("../utils/access");
const { parsePaginationQuery, paginatedJson } = require("../utils/pagination");
const { emitOrgChange } = require("../utils/realtime");
const {
  notifyLotRejected,
  notifyLotPendingReview,
  notifyLotAssigned,
  notifyLotDispatched,
  notifyLotApproved,
  notifyLotUpdated,
  notifyLotDeleted,
} = require("../utils/lotNotifications");

const { toDateOrNull, toDateOrNow } = require("../utils/dateHelpers");

const Joi = require("joi");

router.param("id", validateObjectIdParam);

const stripOwnership = ({
  userId: _userId,
  businessOwnerId: _businessOwnerId,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  _id: _mongoId,
  id: _id,
  ...data
}) => data;
const partyEditableLotFields = new Set([
  "status",
  "dispatchDate",
  "receivedBackDate",
]);

const canonicalLotNumberFromDoc = (doc) =>
  String(doc.lotNumber || doc.lotNo || "").trim();

/** Same workspace = same BusinessOwner document (string/ObjectId tolerant). */
const sameBusinessWorkspace = (storedOwnerId, requestedOwnerId) =>
  String(storedOwnerId ?? "") === String(requestedOwnerId ?? "");

/**
 * Lot numbers must be unique within one business collection only.
 * Query by userId + lot number then filter by businessOwnerId string match so
 * ObjectId vs string storage does not falsely block another collection.
 */
const ensureLotNumberUniqueInCollection = async (
  userId,
  businessOwnerId,
  lotNumber,
  excludeId,
  suitComponent = "main",
  isRework = false
) => {
  const trimmed = String(lotNumber || "").trim();
  if (!trimmed) return;

  const ownerReq = String(businessOwnerId || "").trim();
  if (!ownerReq) {
    const err = new Error("Select a business collection before saving lots.");
    err.code = "MISSING_BUSINESS_OWNER";
    throw err;
  }

  const escaped = escapeRegexString(trimmed);
  const regex = new RegExp(`^${escaped}$`, "i");

  const uid = toObjectId(userId);
  const exclude = excludeId ? toObjectId(excludeId) : null;

  const candidates = await GhausiaLot.find({
    userId: uid,
    $or: [{ lotNumber: regex }, { lotNo: regex }],
    suitComponent,
    isRework: Boolean(isRework),
    ...(exclude ? { _id: { $ne: exclude } } : {}),
  })
    .select("_id businessOwnerId lotNumber lotNo suitComponent isRework")
    .lean();

  const conflict = candidates.find((doc) =>
    sameBusinessWorkspace(doc.businessOwnerId, ownerReq),
  );
  if (!conflict) return;

  const err = new Error(
    `Lot number "${trimmed}" already exists in this collection. Use a different number, or switch to another business if this is intentional.`,
  );
  err.code = "DUPLICATE_LOT_NUMBER";
  throw err;
};

const normalizeStatus = (status) => {
  if (!status) return "pending";
  const normalized = String(status).trim().toLowerCase();
  if (normalized === "receivedback") return "received back";
  if (normalized === "inprogress") return "in progress";
  if (normalized === "pendingapproval") return "pending approval";
  if (
    [
      "pending",
      "dispatched",
      "received back",
      "completed",
      "in progress",
      "pending approval",
      "rejected",
      "processing",
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "pending";
};

const toFiniteNonNeg = (val) => {
  if (val === undefined || val === null || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, n) : null;
};

const sendLotError = (res, error, fallbackMessage) => {
  if (error?.code === "DUPLICATE_LOT_NUMBER" || error?.code === 11000) {
    return res.status(409).json({ message: error.message });
  }
  if (
    error?.code === "MISSING_BUSINESS_OWNER" ||
    error?.name === "ValidationError" ||
    error?.name === "CastError"
  ) {
    return res.status(400).json({ message: error.message });
  }
  return res
    .status(500)
    .json({ message: fallbackMessage, error: error?.message || "Unknown error" });
};

const resolvePartyName = async (partyId, explicitName, userId) => {
  const normalizedName =
    typeof explicitName === "string" ? explicitName.trim() : "";
  if (normalizedName && normalizedName.toLowerCase() !== "unknown") {
    return normalizedName;
  }
  const cleanId = partyId ? String(partyId).trim() : "";
  if (!cleanId) return normalizedName || "Unknown";
  const orConds = [{ id: cleanId }];
  if (mongoose.Types.ObjectId.isValid(cleanId)) {
    orConds.unshift({ _id: cleanId });
  }
  const party = await Party.findOne({ userId, $or: orConds })
    .select("name")
    .lean();
  return party?.name || normalizedName || "Unknown";
};

const normalizeLotPayload = async (payload, userId, businessOwnerId) => {
  const lotNo = payload.lotNo || payload.lotNumber || "";
  const designNo = payload.designNo || "";
  const fabric =
    payload.fabric === "__custom"
      ? payload.customFabric || ""
      : payload.fabric || payload.itemType || "";
  const quantity = Number(payload.quantity ?? payload.pieces ?? 0);
  const billAmount = Number(payload.billAmount || payload.totalAmount || 0);
  const totalAmount = Number(payload.totalAmount ?? billAmount ?? 0);
  const allotDate = toDateOrNow(
    payload.allotDate ?? payload.receivedDate ?? new Date().toISOString(),
  );
  const dispatchDate = toDateOrNull(payload.dispatchDate);
  const receivedBackDate = toDateOrNull(payload.receivedBackDate);
  const status = normalizeStatus(payload.status || "pending");
  const now = new Date();
  const dispatchedAt =
    status === "dispatched"
      ? toDateOrNull(payload.dispatchedAt) || now
      : null;
  const resolvedDispatchDate =
    dispatchDate || (status === "dispatched" ? allotDate || now : null);
  const pendingReviewSubmittedAt =
    status === "pending approval"
      ? toDateOrNull(payload.pendingReviewSubmittedAt) || now
      : null;
  const completionApprovedAt =
    status === "received back" || status === "completed"
      ? toDateOrNull(payload.completionApprovedAt) || now
      : null;
  const notes = payload.description || payload.notes || "";
  const partyId = payload.partyId ? String(payload.partyId) : "";
  const partyName = await resolvePartyName(
    partyId,
    payload.partyName || payload.party || "Unknown",
    userId,
  );

  return {
    userId,
    businessOwnerId,
    lotNo,
    designNo,
    description: notes,
    fabric,
    customFabric: payload.customFabric || "",
    colors: Number(payload.colors || 0),
    pieces: Number(payload.pieces ?? payload.quantity ?? 0),
    allotDate,
    partyId,
    partyName,
    lotNumber: lotNo,
    itemType: payload.itemType || fabric,
    quantity,
    unit: payload.unit || "pieces",
    rate: Number(payload.rate || 0),
    billAmount,
    totalAmount,
    receivedDate: allotDate,
    dispatchDate: resolvedDispatchDate,
    dispatchedAt,
    receivedBackDate: receivedBackDate ? receivedBackDate : null,
    pendingReviewSubmittedAt,
    completionApprovedAt,
    status,
    notes,
    suitType: payload.suitType || "2-piece",
    suitComponent: payload.suitComponent || "main",
    isRework: Boolean(payload.isRework),
    linkedLotId: payload.linkedLotId || null,
  };
};

// Joi schemas for validating lot payloads
const STATUS_VALUES = [
  "pending",
  "dispatched",
  "received back",
  "completed",
  "in progress",
  "pending approval",
  "rejected",
];
const createLotSchema = Joi.object({
  lotNumber: Joi.string().trim().allow("", null).optional(),
  lotNo: Joi.string().trim().allow("", null).optional(),
  designNo: Joi.string().allow("", null),
  description: Joi.string().allow("", null),
  itemType: Joi.string().allow("", null),
  fabric: Joi.string().allow("", null),
  colors: Joi.number().min(0).optional(),
  pieces: Joi.number().min(0).optional(),
  quantity: Joi.number().min(0).optional(),
  allotDate: Joi.date().iso().allow("", null),
  dispatchDate: Joi.date().iso().allow("", null),
  receivedBackDate: Joi.date().iso().allow("", null),
  status: Joi.string()
    .valid(...STATUS_VALUES)
    .optional(),
  billAmount: Joi.number().min(0).optional(),
  partyId: Joi.string().allow("", null).optional(),
  partyName: Joi.string().allow("", null).optional(),
  suitType: Joi.string().valid("2-piece", "3-piece", "dupatta-only").optional(),
  suitComponent: Joi.string().valid("main", "dupatta").optional(),
  isRework: Joi.boolean().optional(),
  dupattaDetails: Joi.object().optional(),
  ownerBillingChoice: Joi.string().optional(),
  linkedLotId: Joi.string().allow("", null).optional(),
});

const updateLotSchema = Joi.object({
  lotNumber: Joi.string().trim().allow("", null).optional(),
  lotNo: Joi.string().trim().allow("", null).optional(),
  designNo: Joi.string().allow("", null).optional(),
  description: Joi.string().allow("", null).optional(),
  itemType: Joi.string().allow("", null).optional(),
  fabric: Joi.string().allow("", null).optional(),
  colors: Joi.number().min(0).optional(),
  pieces: Joi.number().min(0).optional(),
  quantity: Joi.number().min(0).optional(),
  allotDate: Joi.date().iso().allow("", null).optional(),
  dispatchDate: Joi.date().iso().allow("", null).optional(),
  receivedBackDate: Joi.date().iso().allow("", null).optional(),
  status: Joi.string()
    .valid(...STATUS_VALUES)
    .optional(),
  billAmount: Joi.number().min(0).optional(),
  partyId: Joi.string().allow("", null).optional(),
  partyName: Joi.string().allow("", null).optional(),
  suitType: Joi.string().valid("2-piece", "3-piece", "dupatta-only").optional(),
  suitComponent: Joi.string().valid("main", "dupatta").optional(),
  isRework: Joi.boolean().optional(),
  dupattaDetails: Joi.object().optional(),
  ownerBillingChoice: Joi.string().optional(),
  linkedLotId: Joi.string().allow("", null).optional(),
}).min(1);

const normalizeLotUpdatePayload = async (payload, userId) => {
  const normalized = stripOwnership(payload);

  if (payload.status) {
    normalized.status = normalizeStatus(payload.status);
  }

  if (payload.partyId) {
    normalized.partyId = String(payload.partyId);
  }

  if (payload.partyName || payload.party) {
    normalized.partyName = payload.partyName || payload.party;
  }

  if (!normalized.partyName && normalized.partyId) {
    normalized.partyName = await resolvePartyName(
      normalized.partyId,
      "Unknown",
      userId,
    );
  }

  if (payload.lotNumber !== undefined || payload.lotNo !== undefined) {
    const rawVal = payload.lotNumber !== undefined ? payload.lotNumber : payload.lotNo;
    const val = rawVal == null ? "" : String(rawVal).trim();
    normalized.lotNumber = val;
    normalized.lotNo = val;
  }

  if (payload.fabric === "__custom") {
    normalized.fabric = payload.customFabric || "";
  }

  if (payload.quantity != null) {
    normalized.quantity = Number(payload.quantity);
    normalized.pieces = Number(payload.quantity);
  } else if (payload.pieces != null) {
    normalized.pieces = Number(payload.pieces);
    normalized.quantity = Number(payload.pieces);
  }

  if (payload.billAmount != null) {
    normalized.billAmount = Math.max(0, Number(payload.billAmount));
    if (payload.totalAmount == null)
      normalized.totalAmount = Math.max(0, Number(payload.billAmount));
  }

  if (payload.totalAmount != null) {
    normalized.totalAmount = Math.max(0, Number(payload.totalAmount));
  }

  if (payload.allotDate !== undefined) {
    normalized.allotDate = toDateOrNull(payload.allotDate);
    if (normalized.allotDate && normalized.receivedDate == null) {
      normalized.receivedDate = normalized.allotDate;
    }
  }

  if (payload.dispatchDate !== undefined) {
    normalized.dispatchDate = toDateOrNull(payload.dispatchDate);
  }

  if (payload.receivedBackDate !== undefined) {
    normalized.receivedBackDate = toDateOrNull(payload.receivedBackDate);
  }

  if (payload.rejectionNote !== undefined) {
    normalized.rejectionNote = String(payload.rejectionNote || "").trim();
  }

  if (payload.suitType !== undefined) normalized.suitType = payload.suitType;
  if (payload.suitComponent !== undefined) normalized.suitComponent = payload.suitComponent;
  if (payload.isRework !== undefined) normalized.isRework = Boolean(payload.isRework);
  if (payload.linkedLotId !== undefined) normalized.linkedLotId = payload.linkedLotId;

  return normalized;
};

const clearPartyOwnedEditFields = async ({
  userId,
  lotId,
}) => {
  const lotIdStr = String(lotId || "").trim();
  if (!lotIdStr || lotIdStr === "undefined") return;
  await PartyEdit.updateMany(
    {
      userId,
      lotId: lotIdStr,
    },
    {
      $set: {
        notes: "",
        partyVoiceNote: "",
        partyVoiceNoteDuration: 0,
        receipt: null,
        lotImages: [],
        partyBillAmount: null,
        completeDate: null,
        overrideStatus: "",
      },
      $unset: {
        pendingRevision: "",
        billRevisionRequest: "",
        amountChangeNote: "",
      },
    },
  );
};

const syncPartyLedgerForLot = async (lot, userId, businessOwnerId) => {
  const lotIdStr = String(lot.id || lot._id || lot.lotNumber);

  if (!lot.partyId) {
    if (lotIdStr && lotIdStr !== "undefined") {
      await PartyLedger.deleteMany({ userId, lotId: lotIdStr });
      // Scrub only party-owned submission fields so admin notes/voice instructions remain intact.
      await clearPartyOwnedEditFields({ userId, lotId: lotIdStr });
    }
    return;
  }

  const synced = [
    "dispatched",
    "received back",
    "completed",
    "in progress",
    "pending approval",
    "rejected",
  ];
  const ls = normalizeStatus(lot.status);

  if (!synced.includes(ls)) {
    // If status is changed to something like 'pending' that shouldn't be in the ledger,
    // remove the ledger entry and clear overrideStatus while preserving notes/media.
    await PartyLedger.deleteMany({
      userId,
      lotId: String(lot.id || lot._id || lot.lotNumber),
    });
    await PartyEdit.updateMany(
      { userId, lotId: String(lot.id || lot._id || lot.lotNumber) },
      { $set: { overrideStatus: "" } }
    );
    return;
  }

  const entryData = {
    userId,
    businessOwnerId,
    lotId: lot.id || lot._id || lot.lotNumber,
    lotNumber: lot.lotNumber || lot.lotNo,
    designNo: lot.designNo || "",
    description: lot.description || lot.notes || "",
    itemType: lot.itemType || lot.fabric || "",
    colors: Number(lot.colors || 0),
    quantity: Number(lot.quantity ?? lot.pieces ?? 0),
    pieces: Number(lot.pieces ?? lot.quantity ?? 0),
    allotDate: toDateOrNow(lot.allotDate ?? lot.dispatchDate ?? new Date().toISOString()),
    completeDate: lot.receivedBackDate ? toDateOrNull(lot.receivedBackDate) : null,
    partyId: lot.partyId,
    partyName: lot.partyName || "Unknown",
    status: ls,
    billAmount: Number(lot.billAmount || 0),
    receipt: lot.receipt || "",
    notes: lot.notes || "",
  };


  const existing = await PartyLedger.findOne({
    userId,
    businessOwnerId,
    lotId: entryData.lotId,
  });

  if (existing) {
    const reassigned = String(existing.partyId || "") !== String(entryData.partyId || "");
    if (reassigned) {
      // Clear party-owned submission fields (notes, voice, receipt, pictures, bill) without erasing admin notes.
      await clearPartyOwnedEditFields({ userId, businessOwnerId, lotId: String(entryData.lotId) });
    }

    Object.assign(existing, entryData);
    await existing.save();

    if (!reassigned) {
      await PartyEdit.updateMany(
        { userId, lotId: String(entryData.lotId) },
        { $set: { overrideStatus: "" } }
      );
    }
    return existing;
  }

  const newEntry = new PartyLedger(entryData);
  await newEntry.save();

  // Also clear any overrideStatus in PartyEdit to ensure the main lot status takes precedence
  await PartyEdit.updateMany(
    { userId, lotId: String(entryData.lotId) },
    { $set: { overrideStatus: "" } }
  );

  return newEntry;
};

// Get all Ghausia lots
router.get("/", async (req, res) => {
  try {
    const partyAllBiz =
      String(req.query.partyScope || "").toLowerCase() === "all" &&
      isParty(req.user);
    const allWorkspaces =
      String(req.query.scope || "").toLowerCase() === "all" &&
      isTenantAdmin(req.user);

    let filter;
    if (partyAllBiz) {
      filter = getPartyAllBusinessLotsFilter(req.user);
    } else if (allWorkspaces) {
      filter = { userId: getDataOwnerId(req.user) };
    } else {
      filter = getScopedFilter(req);
    }

    const statusQ = String(req.query.status || "").trim();
    if (statusQ) {
      filter.status = new RegExp(`^${escapeRegexString(statusQ)}$`, "i");
    }

    const pagination = parsePaginationQuery(req);
    const sort = { receivedDate: -1 };
    if (pagination.paginate) {
      const [items, total] = await Promise.all([
        GhausiaLot.find(filter)
          .sort(sort)
          .skip(pagination.skip)
          .limit(pagination.limit)
          .lean(),
        GhausiaLot.countDocuments(filter),
      ]);
      const sanitizedItems = isParty(req.user)
        ? items.map(stripPrivateLotFieldsForParty)
        : items;
      return paginatedJson(
        res,
        sanitizedItems,
        total,
        pagination.page,
        pagination.limit,
      );
    }

    const lots = await GhausiaLot.find(filter).sort(sort).lean();
    res.json(
      isParty(req.user) ? lots.map(stripPrivateLotFieldsForParty) : lots,
    );
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching lots", error: error.message });
  }
});

// Admin: approve party completion submission (pending approval → billable received back)
router.post("/:id/approve-completion", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const lot = await GhausiaLot.findOne({ _id: req.params.id, userId });
    if (!lot) {
      return res.status(404).json({ message: "Lot not found" });
    }
    const cur = normalizeStatus(lot.status);
    if (cur !== "pending approval") {
      return res.status(400).json({
        code: "NOT_AWAITING_APPROVAL",
        message: "Lot is not awaiting approval",
      });
    }

    const skipBillable = Boolean(req.body?.skipBillable);

    const lotIdStr = String(lot._id);
    let peDoc = await PartyEdit.findOne({
      lotId: lotIdStr,
      userId,
      businessOwnerId: lot.businessOwnerId,
    });
    if (!peDoc) {
      peDoc = await PartyEdit.findOne({ lotId: lotIdStr, userId });
    }

    const fallbackRecDate = new Date();
    const partySubmittedAnchor =
      toDateOrNull(peDoc?.completeDate) ||
      lot.receivedBackDate ||
      lot.pendingReviewSubmittedAt ||
      fallbackRecDate;

    const lotUpdates = {
      status: skipBillable ? "completed" : "received back",
      receivedBackDate: lot.receivedBackDate || partySubmittedAnchor,
      rejectionNote: "",
      completionApprovedAt: new Date(),
    };

    const ownerBillingChoice = String(
      req.body?.ownerBillingChoice || "",
    ).trim();
    const partyBill = Math.max(0, Number(peDoc?.partyBillAmount ?? 0) || 0);
    if (ownerBillingChoice === "sync_party") {
      lotUpdates.billAmount = partyBill;
      lotUpdates.totalAmount = partyBill;
    } else if (ownerBillingChoice === "custom_ghausia") {
      const custom = Number(req.body?.ownerBillAmount);
      if (Number.isFinite(custom) && custom >= 0) {
        lotUpdates.billAmount = custom;
        lotUpdates.totalAmount = custom;
      }
    } else if (ownerBillingChoice === "delta_only" && peDoc?.pendingRevision) {
      const fromA = Number(peDoc.pendingRevision.fromAmount ?? 0);
      const toA = Number(peDoc.pendingRevision.toAmount ?? 0);
      const delta = toA - fromA;
      const adjusted = Math.max(0, Number(lot.billAmount || 0) + delta);
      lotUpdates.billAmount = adjusted;
      lotUpdates.totalAmount = adjusted;
    }

    // Atomic concurrency guard: only transition if still awaiting approval
    const approvedLot = await GhausiaLot.findOneAndUpdate(
      { _id: req.params.id, userId, status: lot.status },
      { $set: lotUpdates },
      { new: true, runValidators: true },
    );
    if (!approvedLot) {
      return res.status(400).json({
        code: "NOT_AWAITING_APPROVAL",
        message: "Lot is not awaiting approval",
      });
    }

    // Never put the same path (businessOwnerId) in both $set and $setOnInsert — MongoDB rejects conflicting operators
    await PartyEdit.findOneAndUpdate(
      peDoc
        ? { _id: peDoc._id }
        : {
          lotId: lotIdStr,
          userId,
          businessOwnerId: approvedLot.businessOwnerId,
        },
      {
        $set: {
          businessOwnerId: approvedLot.businessOwnerId,
          overrideStatus: "Completed",
          completeDate: peDoc?.completeDate || approvedLot.receivedBackDate || partySubmittedAnchor,
        },
        $setOnInsert: {
          lotId: lotIdStr,
          userId,
        },
        $unset: { pendingRevision: "" },
      },
      { upsert: true, new: true, runValidators: true },
    );

    await syncPartyLedgerForLot(
      approvedLot.toObject({ virtuals: true }),
      userId,
      approvedLot.businessOwnerId,
    );
    emitOrgChange(req, "lot", {
      lotId: String(approvedLot._id),
      action: "lot_approved",
      partyId: String(approvedLot.partyId || ""),
      adminOnly: !approvedLot.partyId,
      linkPath: `/party-ledger?lotId=${String(approvedLot._id)}`,
    });
    res.json(approvedLot);
    void notifyLotApproved({ lot: approvedLot.toObject({ virtuals: true }), ownerId: userId });
    void Notification.updateMany(
      { lotId: String(approvedLot._id), type: "lot_pending_review", readAt: null },
      { $set: { readAt: new Date() } }
    ).then((r) => {
      if (r?.modifiedCount > 0) {
        emitOrgChange(req, "notification", {
          action: "notifications_marked_read",
          targetUserId: String(req.user._id),
          lotId: String(approvedLot._id),
          category: "review_lots",
        });
      }
    }).catch(() => { });
  } catch (error) {
    console.error("[approve-completion] Error:", error);
    const statusCode =
      error?.name === "ValidationError" || error?.name === "CastError" ? 400 : 500;
    res
      .status(statusCode)
      .json({ message: "Could not approve lot", error: error.message });
  }
});

// Admin: reject party completion — lot becomes rejected until party resubmits
router.post("/:id/reject-completion", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const note = String(
      req.body?.rejectionNote ?? req.body?.rejectionReason ?? "",
    ).trim();
    if (!note) {
      return res
        .status(400)
        .json({ message: "Rejection description is required" });
    }

    const lot = await GhausiaLot.findOne({ _id: req.params.id, userId });
    if (!lot) {
      return res.status(404).json({ message: "Lot not found" });
    }
    const cur = normalizeStatus(lot.status);
    if (cur !== "pending approval") {
      return res.status(400).json({
        code: "NOT_AWAITING_APPROVAL",
        message: "Lot is not awaiting approval",
      });
    }

    const rejectedLot = await GhausiaLot.findOneAndUpdate(
      { _id: req.params.id, userId, status: lot.status },
      {
        $set: {
          status: "rejected",
          rejectionNote: note,
          rejectedDate: new Date(),
        },
      },
      { new: true, runValidators: true },
    );
    if (!rejectedLot) {
      return res.status(400).json({
        code: "NOT_AWAITING_APPROVAL",
        message: "Lot is not awaiting approval",
      });
    }

    const lotIdStr = String(rejectedLot._id);
    let existingRejPe = await PartyEdit.findOne({
      lotId: lotIdStr,
      userId,
      businessOwnerId: rejectedLot.businessOwnerId,
    })
      .select("_id")
      .lean();
    if (!existingRejPe) {
      existingRejPe = await PartyEdit.findOne({ lotId: lotIdStr, userId })
        .select("_id")
        .lean();
    }
    await PartyEdit.findOneAndUpdate(
      existingRejPe
        ? { _id: existingRejPe._id }
        : {
          lotId: lotIdStr,
          userId,
          businessOwnerId: rejectedLot.businessOwnerId,
        },
      {
        $set: {
          businessOwnerId: rejectedLot.businessOwnerId,
          overrideStatus: "Rejected",
        },
        $setOnInsert: {
          lotId: lotIdStr,
          userId,
        },
        $unset: { pendingRevision: "" },
      },
      { upsert: true, new: true, runValidators: true },
    );

    await syncPartyLedgerForLot(
      rejectedLot.toObject({ virtuals: true }),
      userId,
      rejectedLot.businessOwnerId,
    );
    const lotObj = rejectedLot.toObject({ virtuals: true });
    emitOrgChange(req, "lot", {
      lotId: String(rejectedLot._id),
      action: "lot_rejected",
      partyId: String(rejectedLot.partyId || ""),
      adminOnly: !rejectedLot.partyId,
      linkPath: `/party-ledger?lotId=${encodeURIComponent(String(rejectedLot._id))}`,
    });
    res.json(rejectedLot);
    void notifyLotRejected({ lot: lotObj, note, ownerId: userId });
    void Notification.updateMany(
      { lotId: String(rejectedLot._id), type: "lot_pending_review", readAt: null },
      { $set: { readAt: new Date() } }
    ).then((r) => {
      if (r?.modifiedCount > 0) {
        emitOrgChange(req, "notification", {
          action: "notifications_marked_read",
          targetUserId: String(req.user._id),
          lotId: String(rejectedLot._id),
          category: "review_lots",
        });
      }
    }).catch(() => { });
  } catch (error) {
    console.error("[reject-completion] Error:", error);
    const statusCode =
      error?.name === "ValidationError" || error?.name === "CastError" ? 400 : 500;
    res
      .status(statusCode)
      .json({ message: "Could not reject lot", error: error.message });
  }
});

// Get single lot
router.get("/:id", async (req, res) => {
  try {
    const filter = isParty(req.user)
      ? getPartyAccessibleLotFilter(req.user, { _id: req.params.id })
      : getScopedFilter(req, { _id: req.params.id });
    const lot = await GhausiaLot.findOne(filter).populate(
      "businessOwnerId",
      "name",
    );
    if (!lot) {
      return res.status(404).json({ message: "Lot not found" });
    }
    if (isParty(req.user)) {
      const stripped = stripPrivateLotFieldsForParty(lot);
      if (stripped.businessOwnerId && typeof stripped.businessOwnerId === "object") {
        const pid = String(req.user.partyId || "").trim();
        const partyDoc =
          pid && require("mongoose").Types.ObjectId.isValid(pid)
            ? await Party.findOne({ _id: pid, userId: getDataOwnerId(req.user) }).lean()
            : null;
        stripped.businessOwnerId = {
          ...stripped.businessOwnerId,
          name: resolvePartyWorkspaceLabel(
            stripped.businessOwnerId._id,
            stripped.businessOwnerId.name,
            partyDoc,
          ),
        };
      }
      return res.json(stripped);
    }
    res.json(lot);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching lot", error: error.message });
  }
});

// Create lot
router.post("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    // Validate incoming payload
    const { error: createErr } = createLotSchema.validate(req.body, {
      abortEarly: false,
      allowUnknown: true,
    });
    if (createErr) {
      return res
        .status(400)
        .json({
          message: "Invalid lot payload",
          details: createErr.details.map((d) => d.message),
        });
    }

    const { dupattaDetails, ownerBillingChoice, ...mainBody } = req.body;

    // Normalize main lot
    const payload = await normalizeLotPayload(
      stripOwnership(mainBody),
      userId,
      req.businessOwnerId,
    );

    if (payload.suitType === "dupatta-only") {
      payload.suitComponent = "dupatta";
      const baseLotNum = payload.lotNumber || "";
      const formattedLotNum = baseLotNum.endsWith("-D") ? baseLotNum : baseLotNum + "-D";
      payload.lotNumber = formattedLotNum;
      payload.lotNo = formattedLotNum;
    }

    // Check uniqueness for main lot
    await ensureLotNumberUniqueInCollection(
      userId,
      req.businessOwnerId,
      canonicalLotNumberFromDoc(payload),
      null,
      payload.suitComponent,
      payload.isRework
    );

    let savedMainLot;
    let savedDupattaLot;

    // Handle 3-piece logic
    const normalizedBillingChoice =
      ownerBillingChoice === "combined" ? "combined" : "separate";
    if (payload.suitType === "3-piece" && dupattaDetails) {
      // Create Main Lot
      const mainLotData = {
        ...payload,
        suitComponent: "main",
        ownerBillingChoice: normalizedBillingChoice,
      };
      const dupattaLotData = {
        ...payload,
        suitComponent: "dupatta",
        ownerBillingChoice: normalizedBillingChoice,
      };
      const baseLotNum = dupattaLotData.lotNumber || "";
      const formattedLotNum = baseLotNum.endsWith("-D") ? baseLotNum : baseLotNum + "-D";
      dupattaLotData.lotNumber = formattedLotNum;
      dupattaLotData.lotNo = formattedLotNum;

      await ensureLotNumberUniqueInCollection(
        userId,
        req.businessOwnerId,
        formattedLotNum,
        null,
        "dupatta",
        payload.isRework,
      );

      // Apply Dupatta Specific Details
      dupattaLotData.partyId = dupattaDetails.partyId ? String(dupattaDetails.partyId).trim() : "";
      if (dupattaLotData.partyId) {
        dupattaLotData.partyName = await resolvePartyName(dupattaLotData.partyId, dupattaDetails.partyName, userId);
      } else {
        dupattaLotData.partyName = "Unknown";
        dupattaLotData.status = "pending";
        dupattaLotData.dispatchDate = null;
        dupattaLotData.dispatchedAt = null;
        dupattaLotData.pendingReviewSubmittedAt = null;
        dupattaLotData.completionApprovedAt = null;
        dupattaLotData.receivedBackDate = null;
      }
      const dupRate = toFiniteNonNeg(dupattaDetails.rate);
      if (dupRate !== null) dupattaLotData.rate = dupRate;
      if (dupattaDetails.fabric) {
        dupattaLotData.fabric = dupattaDetails.fabric;
        dupattaLotData.itemType = dupattaDetails.fabric;
      }
      const dupQty = toFiniteNonNeg(dupattaDetails.quantity);
      if (dupQty !== null) {
        dupattaLotData.quantity = dupQty;
        dupattaLotData.pieces = dupQty;
      }

      const dupBill = toFiniteNonNeg(dupattaDetails.billAmount) ?? 0;
      // Handle Combined vs Separate Billing
      if (normalizedBillingChoice === "combined") {
        // Main gets the combined bill
        mainLotData.billAmount = (toFiniteNonNeg(payload.billAmount) ?? 0) + dupBill;
        mainLotData.totalAmount = mainLotData.billAmount;

        // Dupatta gets 0 owner bill
        dupattaLotData.billAmount = 0;
        dupattaLotData.totalAmount = 0;
      } else {
        // Separate bills
        dupattaLotData.billAmount = dupBill;
        dupattaLotData.totalAmount = dupBill;
      }

      // Create sequentially with rollback so failed dupatta save never leaves an orphan main lot
      const mainLot = new GhausiaLot(mainLotData);
      const dupattaLot = new GhausiaLot(dupattaLotData);

      mainLot.linkedLotId = dupattaLot._id;
      dupattaLot.linkedLotId = mainLot._id;

      savedMainLot = await mainLot.save();
      try {
        savedDupattaLot = await dupattaLot.save();
      } catch (dupErr) {
        await GhausiaLot.findByIdAndDelete(savedMainLot._id).catch(() => { });
        throw dupErr;
      }

      await syncPartyLedgerForLot(savedMainLot, userId, req.businessOwnerId);
      await syncPartyLedgerForLot(savedDupattaLot, userId, req.businessOwnerId);

      emitOrgChange(req, "lot", {
        lotId: String(savedDupattaLot._id),
        partyId: String(savedDupattaLot.partyId || ""),
        adminOnly: !savedDupattaLot.partyId,
      });

    } else {
      // 2-piece or dupatta-only
      const lot = new GhausiaLot({
        ...payload,
        ...(ownerBillingChoice !== undefined
          ? { ownerBillingChoice: normalizedBillingChoice }
          : {}),
      });
      savedMainLot = await lot.save();
      await syncPartyLedgerForLot(savedMainLot, userId, req.businessOwnerId);
    }

    const isMainDispatched = normalizeStatus(savedMainLot.status) === "dispatched" && Boolean(savedMainLot.partyId);
    if (isMainDispatched) {
      emitOrgChange(req, "lot", {
        lotId: String(savedMainLot._id),
        action: "lot_dispatched",
        partyId: String(savedMainLot.partyId),
        linkPath: `/party-ledger?lotId=${String(savedMainLot._id)}`,
      });
    } else if (savedMainLot.partyId) {
      emitOrgChange(req, "lot", {
        lotId: String(savedMainLot._id),
        action: "lot_assigned",
        partyId: String(savedMainLot.partyId),
        linkPath: `/party-ledger?lotId=${String(savedMainLot._id)}`,
      });
    } else {
      emitOrgChange(req, "lot", { lotId: String(savedMainLot._id), adminOnly: true });
    }

    if (savedDupattaLot) {
      const isDupattaDispatched = normalizeStatus(savedDupattaLot.status) === "dispatched" && Boolean(savedDupattaLot.partyId);
      if (isDupattaDispatched) {
        emitOrgChange(req, "lot", {
          lotId: String(savedDupattaLot._id),
          action: "lot_dispatched",
          partyId: String(savedDupattaLot.partyId),
          linkPath: `/party-ledger?lotId=${String(savedDupattaLot._id)}`,
        });
      }
    }

    if (savedDupattaLot) {
      res.status(201).json([savedMainLot, savedDupattaLot]);
    } else {
      res.status(201).json(savedMainLot);
    }

    if (isMainDispatched) {
      void notifyLotDispatched({ lot: savedMainLot.toObject ? savedMainLot.toObject() : savedMainLot, ownerId: userId });
    }
    if (savedDupattaLot && normalizeStatus(savedDupattaLot.status) === "dispatched" && Boolean(savedDupattaLot.partyId)) {
      void notifyLotDispatched({ lot: savedDupattaLot.toObject ? savedDupattaLot.toObject() : savedDupattaLot, ownerId: userId });
    }
  } catch (error) {
    return sendLotError(res, error, "Error creating lot");
  }
});

// Update lot

router.patch("/:id", async (req, res) => {
  try {
    const userId = getDataOwnerId(req.user);
    const lotQuery = isParty(req.user)
      ? getPartyAccessibleLotFilter(req.user, { _id: req.params.id })
      : getScopedFilter(req, { _id: req.params.id });
    const body = isParty(req.user)
      ? Object.fromEntries(
        Object.entries(req.body).filter(([key]) =>
          partyEditableLotFields.has(key),
        ),
      )
      : req.body;
    // Validate update payload (at least one writable field required)
    const { error: updateErr } = updateLotSchema.validate(body, {
      abortEarly: false,
      allowUnknown: true,
    });
    if (updateErr) {
      return res
        .status(400)
        .json({
          message: "Invalid lot update payload",
          details: updateErr.details.map((d) => d.message),
        });
    }
    const existing = await GhausiaLot.findOne(lotQuery);
    if (!existing) {
      return res.status(404).json({ message: "Lot not found" });
    }

    const payload = await normalizeLotUpdatePayload(body, userId);
    delete payload.completionApprovedAt;
    delete payload.dispatchedAt;
    delete payload.pendingReviewSubmittedAt;

    // ── Admin-only: move lot to a different workspace ──
    const moveTarget = String(body.moveToBusinessOwnerId || "").trim();
    if (moveTarget && !isParty(req.user) && moveTarget !== String(existing.businessOwnerId || "")) {
      if (!mongoose.Types.ObjectId.isValid(moveTarget)) {
        return res.status(400).json({ message: "Invalid target workspace id" });
      }
      const checkLotIds = [String(existing._id)];
      if (existing.linkedLotId) checkLotIds.push(String(existing.linkedLotId));
      const blockingBill = await OwnerBill.findOne({
        userId,
        $or: [
          ...(existing.ownerBillId ? [{ _id: existing.ownerBillId }] : []),
          { "lots.lotId": { $in: checkLotIds } },
        ],
      })
        .select("bookNo billNo")
        .lean();
      if (blockingBill) {
        return res.status(409).json({
          message: `Cannot move workspace: lot belongs to Owner Bill #${blockingBill.billNo} (Book ${blockingBill.bookNo}). Remove it from that bill first.`,
        });
      }
      if (
        existing.ownerBillId ||
        existing.billedInBillNo ||
        (existing.linkedLotId &&
          (await GhausiaLot.exists({
            _id: existing.linkedLotId,
            userId,
            $or: [
              { ownerBillId: { $ne: null } },
              { billedInBillNo: { $nin: [null, ""] } },
            ],
          })))
      ) {
        return res.status(409).json({
          message:
            "Cannot move workspace: lot or its linked component is already billed in an Owner Bill.",
        });
      }
      const BusinessOwner = require("../models/BusinessOwner");
      const targetBiz = await BusinessOwner.findOne({
        _id: moveTarget,
        userId,
        deletedAt: null,
        status: "active",
      }).lean();
      if (!targetBiz) {
        return res.status(404).json({ message: "Target business workspace not found" });
      }
      payload.businessOwnerId = moveTarget;
    }
    const effectiveBizOwnerId = payload.businessOwnerId || existing.businessOwnerId;

    if (!isParty(req.user)) {
      const cur = normalizeStatus(existing.status);
      const next =
        payload.status != null ? normalizeStatus(payload.status) : cur;
      const partyChangedForDispatch =
        payload.partyId !== undefined &&
        String(payload.partyId || "") !== String(existing.partyId || "");
      const hasApprovalTs = Boolean(existing.completionApprovedAt);

      if (
        next === "dispatched" &&
        (cur !== "dispatched" || partyChangedForDispatch)
      ) {
        payload.dispatchedAt = new Date();
        if (!payload.dispatchDate) {
          payload.dispatchDate = existing.dispatchDate && !partyChangedForDispatch
            ? existing.dispatchDate
            : new Date();
        }
      } else if (next === "pending" && cur !== "pending") {
        payload.dispatchedAt = null;
        payload.pendingReviewSubmittedAt = null;
        payload.completionApprovedAt = null;
        payload.dispatchDate = null;
        payload.receivedBackDate = null;
      }

      if (next === "pending approval" && cur !== "pending approval") {
        payload.pendingReviewSubmittedAt = new Date();
        if (!payload.receivedBackDate) {
          payload.receivedBackDate = existing.receivedBackDate || new Date();
        }
      } else if (next === "received back" && cur !== "received back") {
        payload.completionApprovedAt = new Date();
        if (!payload.receivedBackDate) {
          payload.receivedBackDate =
            existing.receivedBackDate || existing.pendingReviewSubmittedAt || new Date();
        }
      } else if (
        next === "completed" &&
        cur !== "completed" &&
        !hasApprovalTs
      ) {
        payload.completionApprovedAt = new Date();
        if (!payload.receivedBackDate) {
          payload.receivedBackDate =
            existing.receivedBackDate || existing.pendingReviewSubmittedAt || new Date();
        }
      }
    }

    let becamePendingApproval = false;
    if (isParty(req.user)) {
      const cur = normalizeStatus(existing.status);
      if (cur === "received back" || cur === "completed") {
        return res.status(403).json({
          message:
            "Lots that have been received back or completed cannot be modified by party users.",
        });
      }
      if (payload.status) {
        const next = normalizeStatus(payload.status);
        const allowedPartyTargets = ["dispatched", "in progress", "pending approval"];
        if (!allowedPartyTargets.includes(next)) {
          return res.status(403).json({
            message:
              "You cannot change this lot to that status. Submit for completion from your Party Ledger.",
          });
        }
        if (cur === "pending") {
          return res.status(403).json({
            message:
              "This lot has not been dispatched yet. Wait for the business administrator to dispatch it.",
          });
        }
        if (next === "pending approval") {
          const allowedPrev = [
            "dispatched",
            "in progress",
            "rejected",
            "pending approval",
          ];
          if (!allowedPrev.includes(cur)) {
            return res.status(400).json({
              message:
                "You can submit for approval only when the lot is dispatched, in progress, rejected, or pending approval.",
            });
          }
          if (cur !== "pending approval") {
            becamePendingApproval = true;
            payload.pendingReviewSubmittedAt = new Date();
            if (!payload.receivedBackDate && !existing.receivedBackDate) {
              payload.receivedBackDate = new Date();
            }
            if (cur === "rejected") {
              payload.rejectionNote = "";
            }
          }
        }
        if (next === "dispatched") {
          if (cur !== "dispatched" && !existing.dispatchedAt) {
            payload.dispatchedAt = new Date();
          }
          if (cur === "rejected") {
            payload.rejectionNote = "";
          }
        }
      }
    }

    let newDupattaLot = null;
    let dupattaToDelete = null;
    let updatedLinkedLot = null;
    let pendingRelinkDupatta = null;
    let pendingLinkedUpdate = null;
    let pendingSyncMainPieces = null;

    const isMainComponent = !existing.suitComponent || existing.suitComponent === "main";
    const resolveEffectiveBillingChoice = () => {
      if (payload.ownerBillingChoice !== undefined) {
        return payload.ownerBillingChoice === "combined" ? "combined" : "separate";
      }
      return existing.ownerBillingChoice === "combined" ? "combined" : "separate";
    };

    if ((existing.suitType !== "3-piece" || !existing.linkedLotId) && payload.suitType === "3-piece" && body.dupattaDetails && isMainComponent) {
      const dupattaDetails = body.dupattaDetails;
      const effectiveBillingChoice = resolveEffectiveBillingChoice();
      payload.suitComponent = "main";
      payload.ownerBillingChoice = effectiveBillingChoice;

      let dupattaLotData = {
        ...payload,
        suitComponent: "dupatta",
        suitType: "3-piece",
        ownerBillingChoice: effectiveBillingChoice,
        userId,
        businessOwnerId: effectiveBizOwnerId,
        status: "pending",
        dispatchDate: null,
        dispatchedAt: null,
        receivedBackDate: null,
        pendingReviewSubmittedAt: null,
        completionApprovedAt: null,
        rejectionNote: ""
      };

      const baseLotNum = dupattaLotData.lotNumber || existing.lotNumber || "";
      const formattedLotNum = !baseLotNum
        ? ""
        : baseLotNum.endsWith("-D")
          ? baseLotNum
          : baseLotNum + "-D";
      dupattaLotData.lotNumber = formattedLotNum;
      dupattaLotData.lotNo = formattedLotNum;

      dupattaLotData.partyId = dupattaDetails.partyId ? String(dupattaDetails.partyId).trim() : "";
      if (dupattaLotData.partyId) {
        dupattaLotData.partyName = await resolvePartyName(dupattaLotData.partyId, dupattaDetails.partyName, userId);
      } else {
        dupattaLotData.partyName = "Unknown";
      }
      const dupRate = toFiniteNonNeg(dupattaDetails.rate);
      if (dupRate !== null) dupattaLotData.rate = dupRate;
      if (dupattaDetails.fabric) {
        dupattaLotData.fabric = dupattaDetails.fabric;
        dupattaLotData.itemType = dupattaDetails.fabric;
      }
      const dupQty = toFiniteNonNeg(dupattaDetails.quantity);
      if (dupQty !== null) {
        dupattaLotData.quantity = dupQty;
        dupattaLotData.pieces = dupQty;
      }

      const dupBill = toFiniteNonNeg(dupattaDetails.billAmount) ?? 0;
      if (effectiveBillingChoice === "combined") {
        const mainBaseBill =
          payload.billAmount !== undefined
            ? (toFiniteNonNeg(payload.billAmount) ?? 0)
            : Number(existing.billAmount || 0);
        payload.billAmount = mainBaseBill + dupBill;
        payload.totalAmount = payload.billAmount;
        dupattaLotData.billAmount = 0;
        dupattaLotData.totalAmount = 0;
      } else {
        dupattaLotData.billAmount = dupBill;
        dupattaLotData.totalAmount = dupBill;
      }

      const checkIsRework = payload.isRework !== undefined ? payload.isRework : existing.isRework;

      const checkBaseLotNumber = payload.lotNumber !== undefined ? payload.lotNumber : existing.lotNumber;
      const finalCheckLotNumber = !checkBaseLotNumber
        ? ""
        : (checkBaseLotNumber || "").endsWith("-D")
          ? checkBaseLotNumber
          : checkBaseLotNumber + "-D";

      let existingDupatta = await GhausiaLot.findOne({
        userId,
        businessOwnerId: effectiveBizOwnerId,
        $or: [{ lotNumber: new RegExp(`^${escapeRegexString(finalCheckLotNumber)}$`, "i") }, { lotNo: new RegExp(`^${escapeRegexString(finalCheckLotNumber)}$`, "i") }],
        suitComponent: "dupatta",
        isRework: Boolean(checkIsRework)
      });

      if (existingDupatta) {
        payload.linkedLotId = existingDupatta._id;
        pendingRelinkDupatta = { existingDupatta, dupattaLotData };
      } else {
        await ensureLotNumberUniqueInCollection(
          userId,
          effectiveBizOwnerId,
          finalCheckLotNumber,
          null,
          "dupatta",
          checkIsRework
        );

        newDupattaLot = new GhausiaLot(dupattaLotData);
        payload.linkedLotId = newDupattaLot._id;
        newDupattaLot.linkedLotId = existing._id;
      }
    } else if (existing.suitType === "3-piece" && (payload.suitType === undefined || payload.suitType === "3-piece") && existing.linkedLotId && isMainComponent) {
      const dupattaDetails = body.dupattaDetails || {};
      const effectiveBillingChoice = resolveEffectiveBillingChoice();
      let dupattaUpdateData = {};

      if (payload.ownerBillingChoice !== undefined) {
        payload.ownerBillingChoice = effectiveBillingChoice;
        dupattaUpdateData.ownerBillingChoice = effectiveBillingChoice;
      }

      if (dupattaDetails.partyId !== undefined) {
        dupattaUpdateData.partyId = dupattaDetails.partyId ? String(dupattaDetails.partyId).trim() : "";
        if (dupattaUpdateData.partyId) {
          dupattaUpdateData.partyName = await resolvePartyName(dupattaUpdateData.partyId, dupattaDetails.partyName, userId);
        } else {
          dupattaUpdateData.partyName = "Unknown";
        }
      }
      const dupRate = toFiniteNonNeg(dupattaDetails.rate);
      if (dupRate !== null) dupattaUpdateData.rate = dupRate;
      if (dupattaDetails.fabric) {
        dupattaUpdateData.fabric = dupattaDetails.fabric;
        dupattaUpdateData.itemType = dupattaDetails.fabric;
      }
      const dupQty = toFiniteNonNeg(dupattaDetails.quantity);
      if (dupQty !== null) {
        dupattaUpdateData.quantity = dupQty;
        dupattaUpdateData.pieces = dupQty;
      }

      const hasDupattaBill =
        Object.prototype.hasOwnProperty.call(dupattaDetails, "billAmount") &&
        dupattaDetails.billAmount !== "" &&
        dupattaDetails.billAmount !== null &&
        dupattaDetails.billAmount !== undefined;
      if (effectiveBillingChoice === "combined") {
        if (hasDupattaBill || payload.billAmount !== undefined) {
          const dupBill = hasDupattaBill ? (toFiniteNonNeg(dupattaDetails.billAmount) ?? 0) : 0;
          const mainBaseBill =
            payload.billAmount !== undefined
              ? (toFiniteNonNeg(payload.billAmount) ?? 0)
              : Number(existing.billAmount || 0);
          payload.billAmount = mainBaseBill + dupBill;
          payload.totalAmount = payload.billAmount;
          dupattaUpdateData.billAmount = 0;
          dupattaUpdateData.totalAmount = 0;
        } else if (payload.ownerBillingChoice === "combined") {
          dupattaUpdateData.billAmount = 0;
          dupattaUpdateData.totalAmount = 0;
        }
      } else if (hasDupattaBill) {
        const dupBill = toFiniteNonNeg(dupattaDetails.billAmount) ?? 0;
        dupattaUpdateData.billAmount = dupBill;
        dupattaUpdateData.totalAmount = dupBill;
      }

      if (payload.lotNumber !== undefined) {
        const baseLotNum = payload.lotNumber || "";
        const formattedLotNum = !baseLotNum
          ? ""
          : baseLotNum.endsWith("-D")
            ? baseLotNum
            : baseLotNum + "-D";
        dupattaUpdateData.lotNumber = formattedLotNum;
        dupattaUpdateData.lotNo = formattedLotNum;
      }

      if (payload.isRework !== undefined) {
        dupattaUpdateData.isRework = payload.isRework;
      }

      if (payload.designNo !== undefined) {
        dupattaUpdateData.designNo = payload.designNo;
      }

      if (payload.description !== undefined) {
        dupattaUpdateData.description = payload.description;
      }

      if (payload.colors !== undefined) {
        dupattaUpdateData.colors = payload.colors;
      }

      if (payload.allotDate !== undefined) {
        dupattaUpdateData.allotDate = payload.allotDate;
        dupattaUpdateData.receivedDate = payload.allotDate;
      }

      if (payload.lotNumber !== undefined || payload.isRework !== undefined) {
        const rawLotNumber = payload.lotNumber !== undefined ? payload.lotNumber : existing.lotNumber;
        const checkLotNumber = !rawLotNumber
          ? ""
          : (rawLotNumber || "").endsWith("-D")
            ? rawLotNumber
            : rawLotNumber + "-D";
        const checkIsRework = payload.isRework !== undefined ? payload.isRework : existing.isRework;

        if (checkLotNumber) {
          await ensureLotNumberUniqueInCollection(
            userId,
            effectiveBizOwnerId,
            checkLotNumber,
            existing.linkedLotId,
            "dupatta",
            checkIsRework
          );
        }
      }

      if (Object.keys(dupattaUpdateData).length > 0) {
        pendingLinkedUpdate = dupattaUpdateData;
      }
    } else if (existing.suitType === "3-piece" && payload.suitType !== undefined && payload.suitType !== "3-piece" && isMainComponent) {
      payload.suitComponent = "main";
      payload.linkedLotId = null;
      payload.ownerBillingChoice = "separate";
      if (existing.linkedLotId && String(existing.linkedLotId) !== String(existing._id)) {
        dupattaToDelete = existing.linkedLotId;
      }
    } else if (payload.syncMainLotPieces && existing.suitComponent === "dupatta" && existing.linkedLotId && payload.pieces !== undefined) {
      pendingSyncMainPieces = {
        pieces: payload.pieces,
        quantity: payload.quantity,
      };
    }

    const merged = { ...existing.toObject(), ...payload };
    await ensureLotNumberUniqueInCollection(
      userId,
      effectiveBizOwnerId,
      canonicalLotNumberFromDoc(merged),
      existing._id,
      merged.suitComponent,
      merged.isRework,
    );
    if (
      moveTarget &&
      payload.businessOwnerId === moveTarget &&
      existing.linkedLotId &&
      !dupattaToDelete
    ) {
      const linkedCheckDoc = await GhausiaLot.findOne({
        _id: existing.linkedLotId,
        userId,
      }).lean();
      if (linkedCheckDoc) {
        await ensureLotNumberUniqueInCollection(
          userId,
          moveTarget,
          canonicalLotNumberFromDoc(linkedCheckDoc),
          linkedCheckDoc._id,
          linkedCheckDoc.suitComponent,
          linkedCheckDoc.isRework,
        );
      }
    }

    const partyChanged =
      payload.partyId !== undefined &&
      String(payload.partyId || "") !== String(existing.partyId || "");

    if (dupattaToDelete && String(dupattaToDelete) !== String(existing._id)) {
      const dupBill = await OwnerBill.findOne({
        userId,
        "lots.lotId": String(dupattaToDelete),
      })
        .select("bookNo billNo")
        .lean();
      if (dupBill) {
        return res.status(409).json({
          message: `Linked dupatta is already billed in Owner Bill #${dupBill.billNo} (Book ${dupBill.bookNo}). Remove it from that bill before changing suit type.`,
        });
      }
    }

    if (newDupattaLot) {
      await newDupattaLot.save();
    }

    let lot;
    try {
      lot = await GhausiaLot.findOneAndUpdate(lotQuery, payload, {
        new: true,
        runValidators: true,
      });
      if (!lot) {
        if (newDupattaLot) {
          await GhausiaLot.findByIdAndDelete(newDupattaLot._id).catch(() => {});
        }
        return res.status(404).json({ message: "Lot not found" });
      }
    } catch (mainUpdateErr) {
      if (newDupattaLot) {
        await GhausiaLot.findByIdAndDelete(newDupattaLot._id).catch(() => {});
      }
      throw mainUpdateErr;
    }

    if (pendingRelinkDupatta) {
      const { existingDupatta, dupattaLotData } = pendingRelinkDupatta;
      existingDupatta.linkedLotId = lot._id;
      if (dupattaLotData.ownerBillingChoice !== undefined) existingDupatta.ownerBillingChoice = dupattaLotData.ownerBillingChoice;
      if (dupattaLotData.partyId !== undefined) existingDupatta.partyId = dupattaLotData.partyId;
      if (dupattaLotData.partyName !== undefined) existingDupatta.partyName = dupattaLotData.partyName;
      if (dupattaLotData.rate !== undefined) existingDupatta.rate = dupattaLotData.rate;
      if (dupattaLotData.fabric !== undefined) {
        existingDupatta.fabric = dupattaLotData.fabric;
        existingDupatta.itemType = dupattaLotData.itemType;
      }
      if (dupattaLotData.quantity !== undefined) {
        existingDupatta.quantity = dupattaLotData.quantity;
        existingDupatta.pieces = dupattaLotData.pieces;
      }
      if (dupattaLotData.billAmount !== undefined) {
        existingDupatta.billAmount = dupattaLotData.billAmount;
        existingDupatta.totalAmount = dupattaLotData.totalAmount;
      }
      await existingDupatta.save();
      await syncPartyLedgerForLot(existingDupatta.toObject({ virtuals: true }), userId, effectiveBizOwnerId);
      emitOrgChange(req, "lot", { lotId: String(existingDupatta._id) });
      updatedLinkedLot = existingDupatta;
    } else if (pendingLinkedUpdate) {
      updatedLinkedLot = await GhausiaLot.findOneAndUpdate(
        { _id: existing.linkedLotId, userId },
        pendingLinkedUpdate,
        { new: true },
      );
      if (updatedLinkedLot) {
        await syncPartyLedgerForLot(updatedLinkedLot.toObject({ virtuals: true }), userId, effectiveBizOwnerId);
        emitOrgChange(req, "lot", { lotId: String(updatedLinkedLot._id) });
      }
    } else if (pendingSyncMainPieces) {
      updatedLinkedLot = await GhausiaLot.findOneAndUpdate(
        { _id: existing.linkedLotId, userId },
        pendingSyncMainPieces,
        { new: true },
      );
      if (updatedLinkedLot) {
        emitOrgChange(req, "lot", { lotId: String(updatedLinkedLot._id) });
      }
    }

    if (partyChanged) {
      await clearPartyOwnedEditFields({
        userId,
        businessOwnerId: existing.businessOwnerId,
        lotId: String(lot._id),
      });
    }
    await syncPartyLedgerForLot(
      lot.toObject({ virtuals: true }),
      userId,
      lot.businessOwnerId,
    );
    const lotObj = lot.toObject({ virtuals: true });

    if (newDupattaLot) {
      await syncPartyLedgerForLot(newDupattaLot, userId, effectiveBizOwnerId);
      emitOrgChange(req, "lot", { lotId: String(newDupattaLot._id) });
    }
    if (dupattaToDelete && String(dupattaToDelete) !== String(existing._id)) {
      await GhausiaLot.findOneAndDelete({ _id: dupattaToDelete, userId });
      await Promise.all([
        PartyLedger.deleteMany({ lotId: String(dupattaToDelete), userId }),
        PartyEdit.deleteMany({ lotId: String(dupattaToDelete), userId }),
      ]);
      emitOrgChange(req, "lot", { lotId: String(dupattaToDelete) });
    }

    // ── If lot was moved to a new workspace, migrate PartyLedger/PartyEdit + move linked lot ──
    if (moveTarget && payload.businessOwnerId === moveTarget) {
      const movedLotIds = [String(lot._id)];
      if (existing.linkedLotId && !dupattaToDelete) {
        const linkedMoved = await GhausiaLot.findOneAndUpdate(
          { _id: existing.linkedLotId, userId },
          { businessOwnerId: moveTarget },
          { new: true },
        );
        if (linkedMoved) {
          movedLotIds.push(String(linkedMoved._id));
          updatedLinkedLot = linkedMoved;
          await syncPartyLedgerForLot(linkedMoved.toObject({ virtuals: true }), userId, moveTarget);
          emitOrgChange(req, "lot", { lotId: String(linkedMoved._id) });
        }
      }
      await Promise.all([
        PartyLedger.deleteMany({
          userId,
          businessOwnerId: existing.businessOwnerId,
          lotId: { $in: movedLotIds },
        }),
        PartyEdit.updateMany(
          { userId, lotId: { $in: movedLotIds } },
          { $set: { businessOwnerId: moveTarget } },
        ),
      ]);
    }

    let dispatchNotifyLots = [];
    const oldPartyId = String(existing.partyId || "");
    const newPartyId = String(lotObj.partyId || "");
    if (becamePendingApproval) {
      emitOrgChange(req, "lot", {
        lotId: String(lot._id),
        action: "lot_pending_review",
        partyId: newPartyId,
        adminOnly: !newPartyId,
        linkPath: `/review-lots?lotId=${encodeURIComponent(String(lot._id))}`,
      });
    } else {
      let actionName = undefined;
      let linkPathStr = undefined;
      const oldStatus = normalizeStatus(existing.status);
      const newStatus = normalizeStatus(lotObj.status);
      const isNowDispatched = newStatus === "dispatched" && Boolean(newPartyId);
      const wasDispatchedToSameParty = oldStatus === "dispatched" && oldPartyId === newPartyId;

      if (isNowDispatched && !wasDispatchedToSameParty) {
        actionName = "lot_dispatched";
        linkPathStr = `/party-ledger?lotId=${encodeURIComponent(String(lot._id))}`;
        dispatchNotifyLots.push(lotObj);
      } else if (newPartyId && oldPartyId !== newPartyId) {
        actionName = "lot_assigned";
        linkPathStr = `/party-ledger?lotId=${encodeURIComponent(String(lot._id))}`;
      }

      emitOrgChange(req, "lot", {
        lotId: String(lot._id),
        partyId: newPartyId,
        previousPartyId: oldPartyId,
        adminOnly: !newPartyId && !oldPartyId,
        ...(actionName && { action: actionName }),
        ...(linkPathStr && { linkPath: linkPathStr }),
      });
    }
    if (newDupattaLot || updatedLinkedLot || dupattaToDelete) {
      const responseLots = [lotObj];
      if (newDupattaLot) responseLots.push(newDupattaLot.toObject({ virtuals: true }));
      if (updatedLinkedLot) responseLots.push(updatedLinkedLot.toObject({ virtuals: true }));
      const payloadOut = isParty(req.user)
        ? responseLots.map(stripPrivateLotFieldsForParty)
        : responseLots;
      if (dupattaToDelete) {
        res.json({ lots: payloadOut, deletedLinkedId: String(dupattaToDelete) });
      } else {
        res.json(payloadOut);
      }
    } else {
      res.json(isParty(req.user) ? stripPrivateLotFieldsForParty(lot) : lot);
    }
    if (becamePendingApproval) {
      void notifyLotPendingReview({ lot: lotObj, ownerId: userId });
    }
    for (const dLot of dispatchNotifyLots) {
      void notifyLotDispatched({ lot: dLot, ownerId: userId });
    }
  } catch (error) {
    return sendLotError(res, error, "Error updating lot");
  }
});

// Delete lot
router.delete("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);

    // Bug #1 fix: scope delete by businessOwnerId so a lot from another workspace
    // cannot accidentally be deleted if the IDs collide or are sent incorrectly.
    const deleteQuery = { _id: req.params.id, userId };
    if (req.businessOwnerId) deleteQuery.businessOwnerId = req.businessOwnerId;

    const existingLot = await GhausiaLot.findOne(deleteQuery).lean();
    if (!existingLot) {
      return res.status(404).json({ message: "Lot not found" });
    }

    // Prevent leaving orphaned lots inside finalized OwnerBills or linked Owner payments
    const candidateLotIds = [String(existingLot._id)];
    const candidateBillIds = [];
    if (existingLot.ownerBillId) candidateBillIds.push(existingLot.ownerBillId);
    let orphanDupattaId = null;
    if (existingLot.linkedLotId && (!existingLot.suitComponent || existingLot.suitComponent === "main")) {
      candidateLotIds.push(String(existingLot.linkedLotId));
    } else if (!existingLot.linkedLotId && (!existingLot.suitComponent || existingLot.suitComponent === "main")) {
      const orphan = await GhausiaLot.findOne({
        linkedLotId: existingLot._id,
        userId,
        suitComponent: "dupatta",
      })
        .select("_id ownerBillId")
        .lean();
      if (orphan) {
        orphanDupattaId = orphan._id;
        candidateLotIds.push(String(orphan._id));
        if (orphan.ownerBillId) candidateBillIds.push(orphan.ownerBillId);
      }
    }

    const blockingBill = await OwnerBill.findOne({
      userId,
      $or: [
        ...(candidateBillIds.length ? [{ _id: { $in: candidateBillIds } }] : []),
        { "lots.lotId": { $in: candidateLotIds } },
      ],
    })
      .select("bookNo billNo")
      .lean();
    if (blockingBill) {
      return res.status(409).json({
        message: `Cannot delete: lot belongs to Owner Bill #${blockingBill.billNo} (Book ${blockingBill.bookNo}). Remove it from that bill first.`,
      });
    }

    const lot = await GhausiaLot.findOneAndDelete(deleteQuery);
    if (!lot) {
      return res.status(404).json({ message: "Lot not found" });
    }

    // Use the lot's own businessOwnerId for all cleanup queries (Bug #2 & #5 fix).
    const lotBizId = String(lot.businessOwnerId || "");
    const lotPartyId = String(lot.partyId || "");

    let deletedLinkedId = null;
    let updatedLinkedLot = null;
    let deletedDupattaDoc = null;

    // Delete / downgrade linked lot if it exists
    if (lot.linkedLotId) {
      if (!lot.suitComponent || lot.suitComponent === "main") {
        deletedDupattaDoc = await GhausiaLot.findOneAndDelete({ _id: lot.linkedLotId, userId });
        await Promise.all([
          PartyLedger.deleteMany({ lotId: String(lot.linkedLotId), userId, ...(lotBizId ? { businessOwnerId: lotBizId } : {}) }),
          PartyEdit.deleteMany({ lotId: String(lot.linkedLotId), userId, ...(lotBizId ? { businessOwnerId: lotBizId } : {}) }),
        ]);
        emitOrgChange(req, "lot", {
          lotId: String(lot.linkedLotId),
          partyId: String(deletedDupattaDoc?.partyId || lotPartyId),
          adminOnly: !(deletedDupattaDoc?.partyId || lotPartyId),
        });
        deletedLinkedId = String(lot.linkedLotId);
      } else if (lot.suitComponent === "dupatta") {
        updatedLinkedLot = await GhausiaLot.findOneAndUpdate({ _id: lot.linkedLotId, userId }, {
          suitType: "2-piece",
          linkedLotId: null,
          ownerBillingChoice: "separate"
        }, { new: true });
        if (updatedLinkedLot) {
          emitOrgChange(req, "lot", {
            lotId: String(updatedLinkedLot._id),
            partyId: String(updatedLinkedLot.partyId || lotPartyId),
            adminOnly: !(updatedLinkedLot.partyId || lotPartyId),
          });
        }
      }
    } else if (orphanDupattaId) {
      const orphanDupatta = await GhausiaLot.findOneAndDelete({
        _id: orphanDupattaId,
        userId,
      });
      if (orphanDupatta) {
        deletedDupattaDoc = orphanDupatta;
        await Promise.all([
          PartyLedger.deleteMany({ lotId: String(orphanDupatta._id), userId, ...(lotBizId ? { businessOwnerId: lotBizId } : {}) }),
          PartyEdit.deleteMany({ lotId: String(orphanDupatta._id), userId, ...(lotBizId ? { businessOwnerId: lotBizId } : {}) }),
        ]);
        emitOrgChange(req, "lot", {
          lotId: String(orphanDupatta._id),
          partyId: String(orphanDupatta.partyId || lotPartyId),
          adminOnly: !(orphanDupatta.partyId || lotPartyId),
        });
        deletedLinkedId = String(orphanDupatta._id);
      }
    }

    // Clear stale linkedLot string refs strictly for the deleted lot(s) without cross-clearing Rework/Main variants
    const linkedKeysToClear = [];
    const appendDeletedLotKeys = (doc) => {
      const raw = String(doc?.lotNo || doc?.lotNumber || "").trim();
      if (!raw) return;
      const bare = raw.replace(/-D$/i, "");
      if (doc?.suitComponent === "dupatta") {
        if (doc?.isRework) {
          linkedKeysToClear.push(`${bare}-D (Rework)`, `${bare} (Rework)-D`);
        } else {
          linkedKeysToClear.push(`${bare}-D`);
        }
      } else if (doc?.isRework) {
        linkedKeysToClear.push(`${bare} (Rework)`);
      } else {
        linkedKeysToClear.push(bare);
      }
    };
    appendDeletedLotKeys(lot);
    if (deletedDupattaDoc) appendDeletedLotKeys(deletedDupattaDoc);

    await Promise.all([
      PartyLedger.deleteMany({ lotId: String(lot._id), userId, ...(lotBizId ? { businessOwnerId: lotBizId } : {}) }),
      PartyEdit.deleteMany({ lotId: String(lot._id), userId, ...(lotBizId ? { businessOwnerId: lotBizId } : {}) }),
      ...(linkedKeysToClear.length
        ? [
            Payment.updateMany(
              {
                userId,
                ...(lotBizId ? { businessOwnerId: lotBizId } : {}),
                linkedLot: { $in: linkedKeysToClear },
              },
              { $set: { linkedLot: "" } },
            ),
          ]
        : []),
    ]);

    const responsePayload = { message: "Lot deleted successfully" };
    if (deletedLinkedId) responsePayload.deletedLinkedId = deletedLinkedId;
    if (updatedLinkedLot) responsePayload.updatedLinkedLot = updatedLinkedLot.toObject({ virtuals: true });

    emitOrgChange(req, "lot", {
      lotId: String(lot._id),
      partyId: String(lot.partyId || ""),
      adminOnly: !lot.partyId,
    });
    res.json(responsePayload);

    if (lot.partyId) {
      void notifyLotDeleted({ lot: lot.toObject ? lot.toObject() : lot, ownerId: userId });
    }
    if (deletedDupattaDoc?.partyId) {
      void notifyLotDeleted({
        lot: deletedDupattaDoc.toObject ? deletedDupattaDoc.toObject() : deletedDupattaDoc,
        ownerId: userId,
      });
    }
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting lot", error: error.message });
  }
});

module.exports = router;
