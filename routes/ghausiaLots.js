const express = require("express");
const router = express.Router();
const GhausiaLot = require("../models/GhausiaLot");
const Party = require("../models/Party");
const PartyLedger = require("../models/PartyLedger");
const PartyEdit = require("../models/PartyEdit");
const {
  getDataOwnerId,
  getScopedFilter,
  getPartyAllBusinessLotsFilter,
  getPartyAccessibleLotFilter,
  escapeRegexString,
  isParty,
  requireAdminUser,
  isTenantAdmin,
  toObjectId,
} = require("../utils/access");
const { parsePaginationQuery, paginatedJson } = require("../utils/pagination");
const { emitOrgChange } = require("../utils/realtime");
const {
  notifyLotRejected,
  notifyLotPendingReview,
} = require("../utils/lotNotifications");

const { toDateOrNull, toDateOrNow } = require("../utils/dateHelpers");

const Joi = require("joi");

const stripOwnership = ({ userId, businessOwnerId, createdAt, updatedAt, _id, id, ...data }) => data;
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
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "pending";
};

const resolvePartyName = async (partyId, explicitName, userId) => {
  const normalizedName =
    typeof explicitName === "string" ? explicitName.trim() : "";
  if (normalizedName) return normalizedName;
  if (!partyId) return "Unknown";
  const party = await Party.findOne({
    userId,
    $or: [{ _id: partyId }, { id: partyId }],
  });
  return party?.name || "Unknown";
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
    dispatchDate: dispatchDate ? dispatchDate : null,
    receivedBackDate: receivedBackDate ? receivedBackDate : null,
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
  lotNumber: Joi.string().trim().optional(),
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

  if (payload.lotNumber || payload.lotNo) {
    normalized.lotNumber = payload.lotNumber || payload.lotNo;
    normalized.lotNo = payload.lotNumber || payload.lotNo;
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
    normalized.billAmount = Number(payload.billAmount);
    if (payload.totalAmount == null)
      normalized.totalAmount = Number(payload.billAmount);
  }

  if (payload.totalAmount != null) {
    normalized.totalAmount = Number(payload.totalAmount);
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

const syncPartyLedgerForLot = async (lot, userId, businessOwnerId) => {
  if (!lot.partyId || !lot.lotNumber) return;
  const synced = [
    "dispatched",
    "received back",
    "completed",
    "in progress",
    "pending approval",
    "rejected",
  ];
  const ls = normalizeStatus(lot.status);
  
  const PartyEdit = require("../models/PartyEdit");
  
  if (!synced.includes(ls)) {
    // If status is changed to something like 'pending' that shouldn't be in the ledger,
    // remove the ledger entry and any party edits to keep things clean.
    await PartyLedger.deleteOne({
      userId,
      businessOwnerId,
      lotId: String(lot.id || lot._id || lot.lotNumber),
    });
    await PartyEdit.updateOne(
      { userId, businessOwnerId, lotId: String(lot.id || lot._id || lot.lotNumber) },
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
    Object.assign(existing, entryData);
    await existing.save();
    await PartyEdit.updateOne(
      { userId, businessOwnerId, lotId: String(entryData.lotId) },
      { $set: { overrideStatus: "" } }
    );
    return existing;
  }

  const newEntry = new PartyLedger(entryData);
  await newEntry.save();
  
  // Also clear any overrideStatus in PartyEdit to ensure the main lot status takes precedence
  await PartyEdit.updateOne(
    { userId, businessOwnerId, lotId: String(entryData.lotId) },
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
      return paginatedJson(
        res,
        items,
        total,
        pagination.page,
        pagination.limit,
      );
    }

    const lots = await GhausiaLot.find(filter).sort(sort).lean();
    res.json(lots);
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
      return res.status(400).json({ message: "Lot is not awaiting approval" });
    }

    lot.status = "received back";
    lot.rejectionNote = "";
    lot.completionApprovedAt = new Date();

    const lotIdStr = String(lot._id);
    const peDoc = await PartyEdit.findOne({
      lotId: lotIdStr,
      userId,
      businessOwnerId: lot.businessOwnerId,
    });

    const ownerBillingChoice = String(
      req.body?.ownerBillingChoice || "",
    ).trim();
    const partyBill = Number(peDoc?.partyBillAmount ?? 0);
    if (ownerBillingChoice === "sync_party") {
      lot.billAmount = partyBill;
    } else if (ownerBillingChoice === "custom_ghausia") {
      const custom = Number(req.body?.ownerBillAmount);
      if (Number.isFinite(custom) && custom >= 0) {
        lot.billAmount = custom;
        lot.totalAmount = custom;
      }
    } else if (ownerBillingChoice === "delta_only" && peDoc?.pendingRevision) {
      const fromA = Number(peDoc.pendingRevision.fromAmount ?? 0);
      const toA = Number(peDoc.pendingRevision.toAmount ?? 0);
      const delta = toA - fromA;
      if (delta > 0) lot.billAmount = delta;
    }

    await lot.save();

    await PartyEdit.findOneAndUpdate(
      {
        lotId: lotIdStr,
        userId,
        businessOwnerId: lot.businessOwnerId,
      },
      {
        $set: {
          overrideStatus: "Completed",
          completeDate: lot.receivedBackDate || new Date(),
        },
        $setOnInsert: {
          lotId: lotIdStr,
          userId,
          businessOwnerId: lot.businessOwnerId,
        },
        $unset: { pendingRevision: "" },
      },
      { upsert: true, new: true, runValidators: true },
    );

    await syncPartyLedgerForLot(
      lot.toObject({ virtuals: true }),
      userId,
      lot.businessOwnerId,
    );
    res.json(lot);
    emitOrgChange(req, "lot", { lotId: String(lot._id) });
  } catch (error) {
    res
      .status(400)
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
      return res.status(400).json({ message: "Lot is not awaiting approval" });
    }

    lot.status = "rejected";
    lot.rejectionNote = note;
    await lot.save();

    const lotIdStr = String(lot._id);
    await PartyEdit.findOneAndUpdate(
      {
        lotId: lotIdStr,
        userId,
        businessOwnerId: lot.businessOwnerId,
      },
      {
        $set: {
          overrideStatus: "Rejected",
        },
        $setOnInsert: {
          lotId: lotIdStr,
          userId,
          businessOwnerId: lot.businessOwnerId,
        },
        $unset: { pendingRevision: "" },
      },
      { upsert: true, new: true, runValidators: true },
    );

    await syncPartyLedgerForLot(
      lot.toObject({ virtuals: true }),
      userId,
      lot.businessOwnerId,
    );
    res.json(lot);
    const lotObj = lot.toObject({ virtuals: true });
    emitOrgChange(req, "lot", {
      lotId: String(lot._id),
      action: "lot_rejected",
      partyId: String(lot.partyId || ""),
      linkPath: `/party-ledger?lotId=${encodeURIComponent(String(lot._id))}`,
    });
    void notifyLotRejected({ lot: lotObj, note, ownerId: userId });
  } catch (error) {
    res
      .status(400)
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
    if (payload.suitType === "3-piece" && dupattaDetails) {
      // Create Main Lot
      const mainLotData = { ...payload, suitComponent: "main" };
      let dupattaLotData = { ...payload, suitComponent: "dupatta" };
      const baseLotNum = dupattaLotData.lotNumber || "";
      const formattedLotNum = baseLotNum.endsWith("-D") ? baseLotNum : baseLotNum + "-D";
      dupattaLotData.lotNumber = formattedLotNum;
      dupattaLotData.lotNo = formattedLotNum;

      // Apply Dupatta Specific Details
      dupattaLotData.partyId = dupattaDetails.partyId ? String(dupattaDetails.partyId) : "";
      if (dupattaLotData.partyId) {
        dupattaLotData.partyName = await resolvePartyName(dupattaLotData.partyId, dupattaDetails.partyName, userId);
      } else {
        dupattaLotData.partyName = "Unknown";
      }
      if (dupattaDetails.rate != null) dupattaLotData.rate = Number(dupattaDetails.rate);
      if (dupattaDetails.fabric) {
        dupattaLotData.fabric = dupattaDetails.fabric;
        dupattaLotData.itemType = dupattaDetails.fabric;
      }
      if (dupattaDetails.quantity != null && dupattaDetails.quantity !== "") {
        dupattaLotData.quantity = Number(dupattaDetails.quantity);
        dupattaLotData.pieces = Number(dupattaDetails.quantity);
      }

      // Handle Combined vs Separate Billing
      if (ownerBillingChoice === "combined") {
        // Main gets the combined bill
        mainLotData.billAmount = Number(payload.billAmount) + Number(dupattaDetails.billAmount || 0);
        mainLotData.totalAmount = mainLotData.billAmount;
        
        // Dupatta gets 0 owner bill
        dupattaLotData.billAmount = 0;
        dupattaLotData.totalAmount = 0;
      } else {
        // Separate bills
        dupattaLotData.billAmount = Number(dupattaDetails.billAmount || 0);
        dupattaLotData.totalAmount = dupattaLotData.billAmount;
      }

      // Create them
      const mainLot = new GhausiaLot(mainLotData);
      const dupattaLot = new GhausiaLot(dupattaLotData);
      
      mainLot.linkedLotId = dupattaLot._id;
      dupattaLot.linkedLotId = mainLot._id;

      [savedMainLot, savedDupattaLot] = await Promise.all([
        mainLot.save(),
        dupattaLot.save()
      ]);

      await syncPartyLedgerForLot(savedMainLot, userId, req.businessOwnerId);
      await syncPartyLedgerForLot(savedDupattaLot, userId, req.businessOwnerId);
      
      emitOrgChange(req, "lot", { lotId: String(savedDupattaLot._id) });

    } else {
      // 2-piece or dupatta-only
      const lot = new GhausiaLot(payload);
      savedMainLot = await lot.save();
      await syncPartyLedgerForLot(savedMainLot, userId, req.businessOwnerId);
    }

    if (savedDupattaLot) {
      res.status(201).json([savedMainLot, savedDupattaLot]);
    } else {
      res.status(201).json(savedMainLot);
    }
    emitOrgChange(req, "lot", { lotId: String(savedMainLot._id) });
  } catch (error) {
    if (error.code === "DUPLICATE_LOT_NUMBER") {
      return res.status(409).json({ message: error.message });
    }
    if (error.code === "MISSING_BUSINESS_OWNER") {
      return res.status(400).json({ message: error.message });
    }
    res
      .status(400)
      .json({ message: "Error creating lot", error: error.message });
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

    if (!isParty(req.user)) {
      const cur = normalizeStatus(existing.status);
      const next =
        payload.status != null ? normalizeStatus(payload.status) : cur;
      const hasApprovalTs = Boolean(existing.completionApprovedAt);
      if (cur === "pending approval" && next === "received back") {
        payload.completionApprovedAt = new Date();
      } else if (
        next === "received back" &&
        cur !== "received back" &&
        !hasApprovalTs
      ) {
        payload.completionApprovedAt = new Date();
      } else if (
        next === "completed" &&
        cur !== "completed" &&
        !hasApprovalTs
      ) {
        payload.completionApprovedAt = new Date();
      }
    }

    let becamePendingApproval = false;
    if (isParty(req.user) && payload.status) {
      const next = normalizeStatus(payload.status);
      const cur = normalizeStatus(existing.status);
      if (next === "received back" || next === "completed") {
        return res.status(403).json({
          message:
            "You cannot mark a lot billable directly. Submit for completion from your Party Ledger.",
        });
      }
      if (next === "pending approval") {
        if (cur === "rejected") {
          return res.status(400).json({
            message:
              "This lot was rejected — switch it back to In Progress before submitting again.",
          });
        }
        // Allow pending: ledger often shows In Progress while Ghausia row is still "pending" until dispatch is recorded.
        const allowedPrev = ["pending", "dispatched", "in progress"];
        if (!allowedPrev.includes(cur)) {
          return res.status(400).json({
            message:
              "You can submit for approval only when the lot is pending, dispatched, or in progress.",
          });
        }
        if (cur !== "pending approval") {
          becamePendingApproval = true;
          payload.pendingReviewSubmittedAt = new Date();
        }
      }
      if (next === "dispatched" && cur === "rejected") {
        payload.rejectionNote = "";
      }
    }

    let newDupattaLot = null;
    let dupattaToDelete = null;

    const isMainComponent = !existing.suitComponent || existing.suitComponent === "main";

    if ((existing.suitType !== "3-piece" || !existing.linkedLotId) && payload.suitType === "3-piece" && body.dupattaDetails && isMainComponent) {
      const dupattaDetails = body.dupattaDetails;
      payload.suitComponent = "main";
      
      let dupattaLotData = { 
        ...payload, 
        suitComponent: "dupatta", 
        suitType: "3-piece", 
        userId, 
        businessOwnerId: existing.businessOwnerId,
        status: "pending",
        dispatchDate: null,
        receivedBackDate: null,
        completionApprovedAt: null,
        rejectionNote: ""
      };
      
      const baseLotNum = dupattaLotData.lotNumber || "";
      const formattedLotNum = baseLotNum.endsWith("-D") ? baseLotNum : baseLotNum + "-D";
      dupattaLotData.lotNumber = formattedLotNum;
      dupattaLotData.lotNo = formattedLotNum;
      
      dupattaLotData.partyId = dupattaDetails.partyId ? String(dupattaDetails.partyId) : "";
      if (dupattaLotData.partyId) {
        dupattaLotData.partyName = await resolvePartyName(dupattaLotData.partyId, dupattaDetails.partyName, userId);
      } else {
        dupattaLotData.partyName = "Unknown";
      }
      if (dupattaDetails.rate != null) dupattaLotData.rate = Number(dupattaDetails.rate);
      if (dupattaDetails.fabric) {
        dupattaLotData.fabric = dupattaDetails.fabric;
        dupattaLotData.itemType = dupattaDetails.fabric;
      }
      if (dupattaDetails.quantity != null && dupattaDetails.quantity !== "") {
        dupattaLotData.quantity = Number(dupattaDetails.quantity);
        dupattaLotData.pieces = Number(dupattaDetails.quantity);
      }
      
      if (payload.ownerBillingChoice === "combined") {
        payload.billAmount = Number(payload.billAmount) + Number(dupattaDetails.billAmount || 0);
        payload.totalAmount = payload.billAmount;
        dupattaLotData.billAmount = 0;
        dupattaLotData.totalAmount = 0;
      } else {
        dupattaLotData.billAmount = Number(dupattaDetails.billAmount || 0);
        dupattaLotData.totalAmount = dupattaLotData.billAmount;
      }
      
      const checkLotNumber = payload.lotNumber !== undefined ? payload.lotNumber : existing.lotNumber;
      const checkIsRework = payload.isRework !== undefined ? payload.isRework : existing.isRework;
      
      const checkBaseLotNumber = payload.lotNumber !== undefined ? payload.lotNumber : existing.lotNumber;
      const finalCheckLotNumber = (checkBaseLotNumber || "").endsWith("-D") ? checkBaseLotNumber : checkBaseLotNumber + "-D";

      let existingDupatta = await GhausiaLot.findOne({
        userId,
        businessOwnerId: existing.businessOwnerId,
        $or: [{ lotNumber: new RegExp(`^${escapeRegexString(finalCheckLotNumber)}$`, "i") }, { lotNo: new RegExp(`^${escapeRegexString(finalCheckLotNumber)}$`, "i") }],
        suitComponent: "dupatta",
        isRework: Boolean(checkIsRework)
      });

      if (existingDupatta) {
         payload.linkedLotId = existingDupatta._id;
         existingDupatta.linkedLotId = existing._id;
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
         await syncPartyLedgerForLot(existingDupatta.toObject({ virtuals: true }), userId, existing.businessOwnerId);
         emitOrgChange(req, "lot", { lotId: String(existingDupatta._id) });
      } else {
         await ensureLotNumberUniqueInCollection(
           userId,
           existing.businessOwnerId,
           checkLotNumber,
           null,
           "dupatta",
           checkIsRework
         );
         
         newDupattaLot = new GhausiaLot(dupattaLotData);
         payload.linkedLotId = newDupattaLot._id;
         newDupattaLot.linkedLotId = existing._id;
      }
    } else if (existing.suitType === "3-piece" && payload.suitType === "3-piece" && body.dupattaDetails && existing.linkedLotId && isMainComponent) {
      const dupattaDetails = body.dupattaDetails;
      let dupattaUpdateData = {};
      
      dupattaUpdateData.partyId = dupattaDetails.partyId ? String(dupattaDetails.partyId) : "";
      if (dupattaUpdateData.partyId) {
        dupattaUpdateData.partyName = await resolvePartyName(dupattaUpdateData.partyId, dupattaDetails.partyName, userId);
      } else {
        dupattaUpdateData.partyName = "Unknown";
      }
      if (dupattaDetails.rate != null) dupattaUpdateData.rate = Number(dupattaDetails.rate);
      if (dupattaDetails.fabric) {
        dupattaUpdateData.fabric = dupattaDetails.fabric;
        dupattaUpdateData.itemType = dupattaDetails.fabric;
      }
      if (dupattaDetails.quantity != null && dupattaDetails.quantity !== "") {
        dupattaUpdateData.quantity = Number(dupattaDetails.quantity);
        dupattaUpdateData.pieces = Number(dupattaDetails.quantity);
      }
      
      if (payload.ownerBillingChoice === "combined") {
        payload.billAmount = Number(payload.billAmount) + Number(dupattaDetails.billAmount || 0);
        payload.totalAmount = payload.billAmount;
        dupattaUpdateData.billAmount = 0;
        dupattaUpdateData.totalAmount = 0;
      } else {
        dupattaUpdateData.billAmount = Number(dupattaDetails.billAmount || 0);
        dupattaUpdateData.totalAmount = dupattaUpdateData.billAmount;
      }

      if (payload.lotNumber) {
         const baseLotNum = payload.lotNumber;
         const formattedLotNum = baseLotNum.endsWith("-D") ? baseLotNum : baseLotNum + "-D";
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
         const checkLotNumber = (rawLotNumber || "").endsWith("-D") ? rawLotNumber : rawLotNumber + "-D";
         const checkIsRework = payload.isRework !== undefined ? payload.isRework : existing.isRework;
         
         await ensureLotNumberUniqueInCollection(
           userId,
           existing.businessOwnerId,
           checkLotNumber,
           existing.linkedLotId,
           "dupatta",
           checkIsRework
         );
      }
      
      const updatedDupatta = await GhausiaLot.findByIdAndUpdate(existing.linkedLotId, dupattaUpdateData, { new: true });
      if (updatedDupatta) {
         await syncPartyLedgerForLot(updatedDupatta.toObject({ virtuals: true }), userId, existing.businessOwnerId);
         emitOrgChange(req, "lot", { lotId: String(updatedDupatta._id) });
      }
    } else if (existing.suitType === "3-piece" && payload.suitType !== undefined && payload.suitType !== "3-piece" && isMainComponent) {
      payload.suitComponent = "main";
      payload.linkedLotId = null;
      payload.ownerBillingChoice = "separate";
      if (existing.linkedLotId && String(existing.linkedLotId) !== String(existing._id)) {
        dupattaToDelete = existing.linkedLotId;
      }
    } else if (payload.syncMainLotPieces && existing.suitComponent === "dupatta" && existing.linkedLotId && payload.pieces !== undefined) {
      const updatedMain = await GhausiaLot.findByIdAndUpdate(existing.linkedLotId, {
        pieces: payload.pieces,
        quantity: payload.quantity
      }, { new: true });
      if (updatedMain) {
        emitOrgChange(req, "lot", { lotId: String(updatedMain._id) });
      }
    }

    const merged = { ...existing.toObject(), ...payload };
    await ensureLotNumberUniqueInCollection(
      userId,
      existing.businessOwnerId,
      canonicalLotNumberFromDoc(merged),
      existing._id,
      merged.suitComponent,
      merged.isRework
    );

    const lot = await GhausiaLot.findOneAndUpdate(lotQuery, payload, {
      new: true,
      runValidators: true,
    });
    if (!lot) {
      return res.status(404).json({ message: "Lot not found" });
    }
    await syncPartyLedgerForLot(
      lot.toObject({ virtuals: true }),
      userId,
      lot.businessOwnerId,
    );
    const lotObj = lot.toObject({ virtuals: true });
    
    if (newDupattaLot) {
      await newDupattaLot.save();
      await syncPartyLedgerForLot(newDupattaLot, userId, existing.businessOwnerId);
      emitOrgChange(req, "lot", { lotId: String(newDupattaLot._id) });
    }
    if (dupattaToDelete && String(dupattaToDelete) !== String(existing._id)) {
      await GhausiaLot.findByIdAndDelete(dupattaToDelete);
      await PartyLedger.deleteMany({ lotId: String(dupattaToDelete) });
      emitOrgChange(req, "lot", { lotId: String(dupattaToDelete) });
    }

    if (becamePendingApproval) {
      emitOrgChange(req, "lot", {
        lotId: String(lot._id),
        action: "lot_pending_review",
        linkPath: `/review-lots?lotId=${encodeURIComponent(String(lot._id))}`,
      });
      void notifyLotPendingReview({ lot: lotObj, ownerId: userId });
    } else {
      emitOrgChange(req, "lot", { lotId: String(lot._id) });
    }
    res.json(lot);
  } catch (error) {
    if (error.code === "DUPLICATE_LOT_NUMBER") {
      return res.status(409).json({ message: error.message });
    }
    if (error.code === "MISSING_BUSINESS_OWNER") {
      return res.status(400).json({ message: error.message });
    }
    res
      .status(400)
      .json({ message: "Error updating lot", error: error.message });
  }
});

// Delete lot
router.delete("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const lot = await GhausiaLot.findOneAndDelete({
      _id: req.params.id,
      userId: getDataOwnerId(req.user),
      businessOwnerId: req.businessOwnerId,
    });
    if (!lot) {
      return res.status(404).json({ message: "Lot not found" });
    }
    
    // Delete linked lot if it exists
    if (lot.linkedLotId) {
      if (lot.suitComponent === "main") {
        await GhausiaLot.findByIdAndDelete(lot.linkedLotId);
        await PartyLedger.deleteMany({ lotId: String(lot.linkedLotId) });
        emitOrgChange(req, "lot", { lotId: String(lot.linkedLotId) });
      } else if (lot.suitComponent === "dupatta") {
        const mainLot = await GhausiaLot.findByIdAndUpdate(lot.linkedLotId, {
          suitType: "2-piece",
          linkedLotId: null,
          ownerBillingChoice: "separate"
        }, { new: true });
        if (mainLot) {
          emitOrgChange(req, "lot", { lotId: String(mainLot._id) });
        }
      }
    }
    
    await PartyLedger.deleteMany({ lotId: String(lot._id) });
    
    res.json({ message: "Lot deleted successfully" });
    emitOrgChange(req, "lot", { lotId: String(lot._id) });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting lot", error: error.message });
  }
});

module.exports = router;
