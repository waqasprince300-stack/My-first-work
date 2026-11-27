const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const PartyEdit = require("../models/PartyEdit");
const GhausiaLot = require("../models/GhausiaLot");
const Notification = require("../models/Notification");
const {
  ensureDefaultBusinessOwner,
  getBusinessOwnerFilter,
  getDataOwnerId,
  getOwnerFilter,
  getPartyAllBusinessLotsFilter,
  getPartyAccessibleLotFilter,
  isParty,
  requireAdminUser,
  isTenantAdmin,
  stripPrivatePartyEditFieldsForParty,
  toAggregateObjectIdMatch,
} = require("../utils/access");
const { parsePaginationQuery, paginatedJson } = require("../utils/pagination");
const { emitOrgChange } = require("../utils/realtime");
const {
  notifyBillRevisionRequest,
  notifyBillRevisionResolved,
} = require("../utils/lotNotifications");

const { validateObjectIdParam: _validateObjIdParam } = require("../utils/access");
router.param("id", _validateObjIdParam);
router.param("lotId", _validateObjIdParam);

const stripOwnership = ({
  userId: _userId,
  businessOwnerId: _businessOwnerId,
  _id: _mongoId,
  id: _id,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  ...data
}) => data;

const PARTY_EDIT_PARTY_FIELDS = [
  "completeDate",
  "partyBillAmount",
  "receipt",
  "lotImages",
  "notes",
  "partyVoiceNote",
  "partyVoiceNoteDuration",
  "overrideStatus",
  "pendingRevision",
  "billRevisionRequest",
];

const PARTY_EDIT_PATCH_FIELDS = [
  ...PARTY_EDIT_PARTY_FIELDS,
  "amountChangeNote",
  "adminNotes",
  "adminVoiceNote",
  "adminVoiceNoteDuration",
  "allotDate",
];

const MAX_VOICE_NOTE_DATA_URL_CHARS = 12 * 1024 * 1024;
const MAX_PARTY_EDIT_TOTAL_MEDIA_CHARS = Math.floor(14.5 * 1024 * 1024);
const AUDIO_DATA_URL_RE =
  /^data:audio\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9=.,"\s'+_-]+)*;base64,[A-Za-z0-9+/=\s]+$/i;

function assertPartyEditMediaSizeSafe(payload, existingDoc = null) {
  const effectiveReceipt = Object.prototype.hasOwnProperty.call(payload, "receipt")
    ? payload.receipt
    : existingDoc?.receipt;
  const effectivePartyVoice = Object.prototype.hasOwnProperty.call(payload, "partyVoiceNote")
    ? payload.partyVoiceNote
    : existingDoc?.partyVoiceNote;
  const effectiveAdminVoice = Object.prototype.hasOwnProperty.call(payload, "adminVoiceNote")
    ? payload.adminVoiceNote
    : existingDoc?.adminVoiceNote;
  const effectiveImages = Object.prototype.hasOwnProperty.call(payload, "lotImages")
    ? payload.lotImages
    : existingDoc?.lotImages;

  let total = 0;
  if (typeof effectiveReceipt === "string") total += effectiveReceipt.length;
  if (typeof effectivePartyVoice === "string") total += effectivePartyVoice.length;
  if (typeof effectiveAdminVoice === "string") total += effectiveAdminVoice.length;
  if (Array.isArray(effectiveImages)) {
    for (const img of effectiveImages) {
      if (typeof img === "string") total += img.length;
    }
  }
  if (total > MAX_PARTY_EDIT_TOTAL_MEDIA_CHARS) {
    return "Combined attachments (voice notes, receipt, and pictures) exceed the maximum record size (~14.5 MB). Upload shorter recordings or fewer images.";
  }
  return null;
}

function normalizeAndValidateVoiceNotes(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const [field, durField] of [
    ["partyVoiceNote", "partyVoiceNoteDuration"],
    ["adminVoiceNote", "adminVoiceNoteDuration"],
  ]) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      const raw = payload[field];
      if (raw == null) {
        payload[field] = "";
        payload[durField] = 0;
        continue;
      }
      if (typeof raw !== "string") {
        return `${field} must be an audio data URL string`;
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        payload[field] = "";
        payload[durField] = 0;
        continue;
      }
      if (trimmed.length > MAX_VOICE_NOTE_DATA_URL_CHARS) {
        return `${field} is too large to store in one record`;
      }
      if (!AUDIO_DATA_URL_RE.test(trimmed)) {
        return `${field} must be a valid base64 audio recording`;
      }
      payload[field] = trimmed;
    }
    if (Object.prototype.hasOwnProperty.call(payload, durField)) {
      const n = Number(payload[durField]);
      payload[durField] =
        Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
    }
  }
  return null;
}

function enforcePartyPostApprovalLock(
  req,
  targetLotStatus,
  payload,
  targetLot = null,
  existingPe = null,
) {
  if (!isParty(req.user)) return null;

  const isCompletedOrApproved =
    targetLotStatus === "completed" || targetLotStatus === "received back";

  if (Object.prototype.hasOwnProperty.call(payload, "billRevisionRequest")) {
    const rev = payload.billRevisionRequest;
    if (!isCompletedOrApproved) {
      return "Bill revision can only be requested on completed or approved lots.";
    }
    if (!rev || typeof rev !== "object" || Array.isArray(rev)) {
      return "Invalid bill revision request payload.";
    }
    const toAmt = Number(rev.toAmount);
    if (!Number.isFinite(toAmt) || toAmt < 0) {
      return "Requested revised bill amount must be a valid non-negative number.";
    }
    const serverFromAmt = Number(
      existingPe?.partyBillAmount ?? targetLot?.billAmount ?? 0,
    );
    payload.billRevisionRequest = {
      fromAmount: Number.isFinite(serverFromAmt) && serverFromAmt >= 0 ? serverFromAmt : 0,
      toAmount: Math.round(toAmt),
      reason: String(rev.reason || "").trim().slice(0, 500),
      status: "pending",
      requestedAt: new Date().toISOString(),
    };
  }

  if (!isCompletedOrApproved) {
    return null;
  }
  const lockedAttempt =
    Object.prototype.hasOwnProperty.call(payload, "partyBillAmount") ||
    Object.prototype.hasOwnProperty.call(payload, "overrideStatus") ||
    Object.prototype.hasOwnProperty.call(payload, "amountChangeNote") ||
    Object.prototype.hasOwnProperty.call(payload, "completeDate") ||
    Object.prototype.hasOwnProperty.call(payload, "pendingRevision") ||
    Object.prototype.hasOwnProperty.call(payload, "receipt") ||
    Object.prototype.hasOwnProperty.call(payload, "lotImages") ||
    Object.prototype.hasOwnProperty.call(payload, "notes") ||
    Object.prototype.hasOwnProperty.call(payload, "partyVoiceNote") ||
    Object.prototype.hasOwnProperty.call(payload, "partyVoiceNoteDuration");
  delete payload.partyBillAmount;
  delete payload.overrideStatus;
  delete payload.amountChangeNote;
  delete payload.completeDate;
  delete payload.pendingRevision;
  delete payload.receipt;
  delete payload.lotImages;
  delete payload.notes;
  delete payload.partyVoiceNote;
  delete payload.partyVoiceNoteDuration;
  if (lockedAttempt) {
    return "Lot is already approved or completed. Party amount, bill receipt, pictures, notes, and voice note cannot be changed without admin permission.";
  }
  return null;
}

const ADMIN_LOCKED_NOTE_FIELDS = [
  "adminNotes",
  "adminVoiceNote",
  "adminVoiceNoteDuration",
];

function enforceAdminPostApprovalLock(
  targetLotStatus,
  payload,
  existingDoc = null,
  allowInitialCreate = false,
) {
  if (
    allowInitialCreate ||
    (targetLotStatus !== "completed" && targetLotStatus !== "received back") ||
    !payload ||
    typeof payload !== "object"
  ) {
    return null;
  }
  let changed = false;
  for (const field of ADMIN_LOCKED_NOTE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const nextNorm =
      field === "adminVoiceNoteDuration"
        ? Math.round(Number(payload[field] || 0))
        : String(payload[field] ?? "").trim();
    const prevNorm = existingDoc
      ? field === "adminVoiceNoteDuration"
        ? Math.round(Number(existingDoc[field] || 0))
        : String(existingDoc[field] ?? "").trim()
      : field === "adminVoiceNoteDuration"
        ? 0
        : "";
    if (nextNorm !== prevNorm) {
      changed = true;
    } else {
      delete payload[field];
    }
  }
  if (changed) {
    return "Lot is already approved or completed. Admin note and voice note cannot be changed after approval.";
  }
  return null;
}

const pickPartyEditPatch = (body) => {
  const out = {};
  for (const key of PARTY_EDIT_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
};

/** Attach hasReceipt / voice / lotImagesCount without shipping base64 blobs. */
async function attachPartyEditImageMeta(filter, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (rows || []).map((p) => ({ ...p, id: String(p._id || p.id) }));
  }
  const [withReceipt, withPartyVoice, withAdminVoice, imageMeta] = await Promise.all([
    PartyEdit.find({
      ...filter,
      receipt: { $exists: true, $nin: ["", null] },
    })
      .select("_id")
      .lean(),
    PartyEdit.find({
      ...filter,
      partyVoiceNote: { $exists: true, $nin: ["", null] },
    })
      .select("_id")
      .lean(),
    PartyEdit.find({
      ...filter,
      adminVoiceNote: { $exists: true, $nin: ["", null] },
    })
      .select("_id")
      .lean(),
    PartyEdit.aggregate([
      { $match: toAggregateObjectIdMatch(filter) },
      {
        $project: {
          _id: 1,
          lotImagesCount: { $size: { $ifNull: ["$lotImages", []] } },
        },
      },
    ]),
  ]);
  const receiptIds = new Set(withReceipt.map((d) => String(d._id)));
  const partyVoiceIds = new Set(withPartyVoice.map((d) => String(d._id)));
  const adminVoiceIds = new Set(withAdminVoice.map((d) => String(d._id)));
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
      hasPartyVoiceNote:
        typeof doc.partyVoiceNote === "string" &&
        doc.partyVoiceNote.trim() !== ""
          ? true
          : partyVoiceIds.has(id),
      hasAdminVoiceNote:
        typeof doc.adminVoiceNote === "string" &&
        doc.adminVoiceNote.trim() !== ""
          ? true
          : adminVoiceIds.has(id),
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

const getAllowedPartyLotIds = async (req, { allBusinesses = false } = {}) => {
  if (!isParty(req.user)) return null;
  if (allBusinesses) {
    const lots = await GhausiaLot.find(getPartyAllBusinessLotsFilter(req.user))
      .select("_id")
      .lean();
    return lots.map((lot) => String(lot._id));
  }
  const pid = String(req.user.partyId || "").trim();
  if (!pid) return [];
  const lots = await GhausiaLot.find({
    userId: getDataOwnerId(req.user),
    partyId: pid,
  })
    .select("_id")
    .lean();
  return lots.map((lot) => String(lot._id));
};

const serializePartyEditForUser = (docObj, user) => {
  const withFlags = withVoiceFlags(docObj);
  return isParty(user) ? stripPrivatePartyEditFieldsForParty(withFlags) : withFlags;
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
    // Base64 media blobs are heavy — excluded unless explicitly requested.
    // includeReceipts = bill only; includeLotImages = lot pictures only; includeVoiceNotes = voice notes (see GET /lot/:id).
    const heavyImageSelect =
      "-receipt -lotImages -partyVoiceNote -adminVoiceNote";
    let query = PartyEdit.find(filter).sort({ createdAt: -1 });
    if (!includeReceipts) query = query.select(heavyImageSelect);
    else query = query.select("-lotImages -partyVoiceNote -adminVoiceNote");
    if (pagination.paginate) {
      const [rows, total] = await Promise.all([
        PartyEdit.find(filter)
          .sort({ createdAt: -1 })
          .select(
            includeReceipts
              ? "-lotImages -partyVoiceNote -adminVoiceNote"
              : heavyImageSelect,
          )
          .skip(pagination.skip)
          .limit(pagination.limit)
          .lean(),
        PartyEdit.countDocuments(filter),
      ]);
      const withMeta = await attachPartyEditImageMeta(filter, rows);
      const sanitized = isParty(req.user)
        ? withMeta.map(stripPrivatePartyEditFieldsForParty)
        : withMeta;
      return paginatedJson(
        res,
        sanitized,
        total,
        pagination.page,
        pagination.limit,
      );
    }
    const partyEdits = await query.lean();
    const withMeta = await attachPartyEditImageMeta(filter, partyEdits);
    res.json(
      isParty(req.user)
        ? withMeta.map(stripPrivatePartyEditFieldsForParty)
        : withMeta,
    );
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching party edits", error: error.message });
  }
});

// Get party edit for a single lot (optional receipt / lot pictures / voice notes for lazy loading)
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
    const includeVoiceNotes =
      String(req.query.includeVoiceNotes || "").toLowerCase() === "1" ||
      req.query.includeVoiceNotes === "true";

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
    if (!includeVoiceNotes) exclude.push("-partyVoiceNote", "-adminVoiceNote");
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
      return res.json({
        id: null,
        lotId: lotIdStr,
        receipt: "",
        hasReceipt: false,
        hasLotImages: false,
        lotImagesCount: 0,
        hasPartyVoiceNote: false,
        hasAdminVoiceNote: false,
        partyVoiceNoteDuration: 0,
        adminVoiceNoteDuration: 0,
        adminNotes: "",
      });
    }
    const lotImagesCount = Array.isArray(row.lotImages)
      ? row.lotImages.length
      : undefined;
    let hasPartyVoiceNote;
    let hasAdminVoiceNote;
    if (includeVoiceNotes) {
      hasPartyVoiceNote =
        typeof row.partyVoiceNote === "string" &&
        row.partyVoiceNote.trim() !== "";
      hasAdminVoiceNote =
        typeof row.adminVoiceNote === "string" &&
        row.adminVoiceNote.trim() !== "";
    } else {
      const [pv, av] = await Promise.all([
        PartyEdit.exists({
          _id: row._id,
          partyVoiceNote: { $exists: true, $nin: ["", null] },
        }),
        PartyEdit.exists({
          _id: row._id,
          adminVoiceNote: { $exists: true, $nin: ["", null] },
        }),
      ]);
      hasPartyVoiceNote = Boolean(pv);
      hasAdminVoiceNote = Boolean(av);
    }
    const payloadOut = {
      ...row,
      id: String(row._id),
      hasPartyVoiceNote,
      hasAdminVoiceNote,
      ...(lotImagesCount !== undefined
        ? { lotImagesCount, hasLotImages: lotImagesCount > 0 }
        : {}),
    };
    res.json(
      isParty(req.user)
        ? stripPrivatePartyEditFieldsForParty(payloadOut)
        : payloadOut,
    );
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching party edit", error: error.message });
  }
});

const withVoiceFlags = (docObj) => ({
  ...docObj,
  id: docObj?._id ? String(docObj._id) : docObj?.id,
  hasPartyVoiceNote:
    typeof docObj?.partyVoiceNote === "string" &&
    docObj.partyVoiceNote.trim() !== "",
  hasAdminVoiceNote:
    typeof docObj?.adminVoiceNote === "string" &&
    docObj.adminVoiceNote.trim() !== "",
});

// Get single party edit
router.get("/:id", async (req, res) => {
  try {
    const allowedLotIds = await getAllowedPartyLotIds(req, { allBusinesses: true });
    const partyEdit = await PartyEdit.findOne({
      _id: req.params.id,
      ...getOwnerFilter(req),
      ...(isParty(req.user) || isTenantAdmin(req.user) ? {} : getBusinessOwnerFilter(req)),
      ...(allowedLotIds !== null ? { lotId: { $in: allowedLotIds } } : {}),
    });
    if (!partyEdit) {
      return res.status(404).json({ message: "Party edit not found" });
    }
    const obj = partyEdit.toObject();
    const imgCount = Array.isArray(obj.lotImages) ? obj.lotImages.length : 0;
    res.json({
      ...serializePartyEditForUser(obj, req.user),
      hasReceipt: typeof obj.receipt === "string" && obj.receipt.trim() !== "",
      lotImagesCount: imgCount,
      hasLotImages: imgCount > 0,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching party edit", error: error.message });
  }
});

// Create party edit (upserts by lotId+userId if cleanLotId already has a record)
router.post("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const payload = stripOwnership(req.body);
    const ownerId = getDataOwnerId(req.user);
    const cleanLotId = payload.lotId ? String(payload.lotId).trim() : "";
    let businessOwnerId = req.businessOwnerId;
    let targetLotPartyId = "";
    let existingDoc = null;
    if (cleanLotId) {
      if (!mongoose.Types.ObjectId.isValid(cleanLotId)) {
        return res.status(400).json({ message: "Invalid lotId" });
      }
      const targetLot = await GhausiaLot.findOne({
        _id: cleanLotId,
        userId: ownerId,
      })
        .select("status createdAt businessOwnerId partyId")
        .lean();
      if (!targetLot) {
        return res.status(404).json({ message: "Lot not found" });
      }
      targetLotPartyId = String(targetLot.partyId || "");
      if (targetLot.businessOwnerId) {
        businessOwnerId = String(targetLot.businessOwnerId);
      }
      existingDoc = await PartyEdit.findOne({
        lotId: cleanLotId,
        userId: ownerId,
      }).lean();
      if (
        ADMIN_LOCKED_NOTE_FIELDS.some((f) =>
          Object.prototype.hasOwnProperty.call(payload, f),
        )
      ) {
        const targetLotStatus = String(targetLot.status || "")
          .toLowerCase()
          .trim();
        const allowInitialCreate =
          !existingDoc &&
          Boolean(targetLot.createdAt) &&
          Date.now() - new Date(targetLot.createdAt).getTime() <= 120000;
        const adminLockError = enforceAdminPostApprovalLock(
          targetLotStatus,
          payload,
          existingDoc,
          allowInitialCreate,
        );
        if (adminLockError) {
          return res.status(403).json({ message: adminLockError });
        }
      }
    }
    const voiceError = normalizeAndValidateVoiceNotes(payload);
    if (voiceError) {
      return res.status(400).json({ message: voiceError });
    }
    const sizeError = assertPartyEditMediaSizeSafe(payload, existingDoc);
    if (sizeError) {
      return res.status(400).json({ message: sizeError });
    }
    const savedPartyEdit = existingDoc
      ? await PartyEdit.findOneAndUpdate(
          { _id: existingDoc._id },
          { ...payload, userId: ownerId, businessOwnerId },
          { new: true, runValidators: true },
        )
      : await new PartyEdit({
          ...payload,
          userId: ownerId,
          businessOwnerId,
        }).save();
    emitOrgChange(req, "partyEdit", {
      lotId: String(savedPartyEdit.lotId || ""),
      partyId: targetLotPartyId,
      adminOnly: !targetLotPartyId,
    });
    res.status(existingDoc ? 200 : 201).json(serializePartyEditForUser(savedPartyEdit.toObject(), req.user));
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error creating party edit", error: error.message });
  }
});

// Update party edit by MongoDB _id
router.patch("/:id", async (req, res) => {
  try {
    const allowedLotIds = await getAllowedPartyLotIds(req, { allBusinesses: true });
    const accessFilter = {
      _id: req.params.id,
      ...getOwnerFilter(req),
      ...(isParty(req.user) || isTenantAdmin(req.user) ? {} : getBusinessOwnerFilter(req)),
      ...(allowedLotIds !== null ? { lotId: { $in: allowedLotIds } } : {}),
    };
    const patch = isParty(req.user)
      ? Object.fromEntries(
          PARTY_EDIT_PARTY_FIELDS.filter((f) =>
            Object.prototype.hasOwnProperty.call(req.body || {}, f),
          ).map((f) => [f, req.body[f]]),
        )
      : pickPartyEditPatch(req.body);

    const touchesAdminNote = ADMIN_LOCKED_NOTE_FIELDS.some((f) =>
      Object.prototype.hasOwnProperty.call(patch, f),
    );
    const touchesMedia =
      Object.prototype.hasOwnProperty.call(patch, "receipt") ||
      Object.prototype.hasOwnProperty.call(patch, "partyVoiceNote") ||
      Object.prototype.hasOwnProperty.call(patch, "adminVoiceNote") ||
      Object.prototype.hasOwnProperty.call(patch, "lotImages");
    const needsExisting =
      isParty(req.user) || touchesAdminNote || touchesMedia;
    let existing = null;
    if (needsExisting) {
      existing = await PartyEdit.findOne(accessFilter)
        .select(
          "lotId partyBillAmount adminNotes adminVoiceNote adminVoiceNoteDuration receipt partyVoiceNote lotImages",
        )
        .lean();
      if (!existing) {
        return res.status(404).json({ message: "Party edit not found" });
      }
    }

    let targetLotPartyId = "";
    if (existing?.lotId) {
      const targetLot = await GhausiaLot.findOne({
        _id: existing.lotId,
        userId: getDataOwnerId(req.user),
      })
        .select("status billAmount partyId")
        .lean();
      targetLotPartyId = String(targetLot?.partyId || "");
      const targetLotStatus = String(targetLot?.status || "")
        .toLowerCase()
        .trim();
      const lockError = enforcePartyPostApprovalLock(
        req,
        targetLotStatus,
        patch,
        targetLot,
        existing,
      );
      if (lockError) {
        return res.status(403).json({ message: lockError });
      }
      if (touchesAdminNote) {
        const adminLockError = enforceAdminPostApprovalLock(
          targetLotStatus,
          patch,
          existing,
          false,
        );
        if (adminLockError) {
          return res.status(403).json({ message: adminLockError });
        }
      }
    }

    const voiceError = normalizeAndValidateVoiceNotes(patch);
    if (voiceError) {
      return res.status(400).json({ message: voiceError });
    }
    const sizeError = assertPartyEditMediaSizeSafe(patch, existing);
    if (sizeError) {
      return res.status(400).json({ message: sizeError });
    }

    if (Object.prototype.hasOwnProperty.call(patch, "lotImages")) {
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
    if (!targetLotPartyId && partyEdit.lotId) {
      const lt = await GhausiaLot.findById(partyEdit.lotId).select("partyId").lean();
      targetLotPartyId = String(lt?.partyId || "");
    }
    emitOrgChange(req, "partyEdit", {
      lotId: String(partyEdit.lotId || ""),
      partyId: targetLotPartyId,
      adminOnly: !targetLotPartyId,
    });
    res.json(serializePartyEditForUser(partyEdit.toObject(), req.user));
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
    let businessOwnerId = String(req.businessOwnerId || "").trim();

    let targetLotDoc = null;
    let targetLotStatus = "";
    let lotCreatedAt = null;
    if (isParty(req.user)) {
      const lot = await GhausiaLot.findOne(
        getPartyAccessibleLotFilter(req.user, { _id: lotId }),
      );
      if (!lot) {
        return res
          .status(404)
          .json({ message: "Lot not found for this party" });
      }
      targetLotDoc = lot;
      businessOwnerId = String(lot.businessOwnerId || businessOwnerId).trim();
      targetLotStatus = String(lot.status || "").toLowerCase().trim();
      lotCreatedAt = lot.createdAt || null;
    } else {
      const lot = await GhausiaLot.findOne({ _id: lotId, userId })
        .select("businessOwnerId status createdAt billAmount partyId")
        .lean();
      if (!lot) {
        return res.status(404).json({ message: "Lot not found" });
      }
      targetLotDoc = lot;
      targetLotStatus = String(lot.status || "").toLowerCase().trim();
      lotCreatedAt = lot.createdAt || null;
      if (lot.businessOwnerId) {
        businessOwnerId = String(lot.businessOwnerId).trim();
      }
    }
    if (!businessOwnerId) {
      const defaultBiz = await ensureDefaultBusinessOwner(req.user);
      businessOwnerId = defaultBiz ? String(defaultBiz._id) : "";
    }
    if (!businessOwnerId) {
      return res.status(400).json({ message: "Business workspace is missing for this lot" });
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

    const picked = isParty(req.user)
      ? Object.fromEntries(
          PARTY_EDIT_PARTY_FIELDS.filter((f) =>
            Object.prototype.hasOwnProperty.call(req.body || {}, f),
          ).map((f) => [f, req.body[f]]),
        )
      : stripOwnership(req.body);

    // Always resolve existing PartyEdit by (lotId, userId, businessOwnerId) with fallback to (lotId, userId)
    // BEFORE lock checks and BEFORE updating by `_id`, so mismatched businessOwnerId never creates duplicates.
    let existingPe = await PartyEdit.findOne({
      lotId,
      userId,
      businessOwnerId,
    })
      .select(
        "_id adminNotes adminVoiceNote adminVoiceNoteDuration receipt partyVoiceNote lotImages partyBillAmount billRevisionRequest",
      )
      .lean();
    if (!existingPe) {
      existingPe = await PartyEdit.findOne({ lotId, userId })
        .select(
          "_id adminNotes adminVoiceNote adminVoiceNoteDuration receipt partyVoiceNote lotImages partyBillAmount billRevisionRequest",
        )
        .lean();
    }

    const lockError = enforcePartyPostApprovalLock(
      req,
      targetLotStatus,
      picked,
      targetLotDoc,
      existingPe,
    );
    if (lockError) {
      return res.status(403).json({ message: lockError });
    }

    const touchesAdminNote = ADMIN_LOCKED_NOTE_FIELDS.some((f) =>
      Object.prototype.hasOwnProperty.call(picked, f),
    );

    if (
      (targetLotStatus === "completed" ||
        targetLotStatus === "received back") &&
      touchesAdminNote
    ) {
      const allowInitialCreate =
        !existingPe &&
        Boolean(lotCreatedAt) &&
        Date.now() - new Date(lotCreatedAt).getTime() <= 120000;
      const adminLockError = enforceAdminPostApprovalLock(
        targetLotStatus,
        picked,
        existingPe,
        allowInitialCreate,
      );
      if (adminLockError) {
        return res.status(403).json({ message: adminLockError });
      }
    }

    const voiceError = normalizeAndValidateVoiceNotes(picked);
    if (voiceError) {
      return res.status(400).json({ message: voiceError });
    }
    const sizeError = assertPartyEditMediaSizeSafe(picked, existingPe);
    if (sizeError) {
      return res.status(400).json({ message: sizeError });
    }

    const data = {
      ...picked,
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

    const prevBillRev = existingPe?.billRevisionRequest || null;

    const partyEdit = await PartyEdit.findOneAndUpdate(
      existingPe ? { _id: existingPe._id } : { lotId, userId, businessOwnerId },
      update,
      { new: true, upsert: true, runValidators: true },
    );
    const bodyRev = picked.billRevisionRequest ?? req.body?.billRevisionRequest;
    const isNewPendingBillRev =
      isParty(req.user) &&
      Object.prototype.hasOwnProperty.call(
        req.body || {},
        "billRevisionRequest",
      ) &&
      bodyRev &&
      typeof bodyRev === "object" &&
      String(bodyRev.status || "").toLowerCase() === "pending";

    const isRevResolvedByAdmin =
      !isParty(req.user) &&
      Object.prototype.hasOwnProperty.call(
        req.body || {},
        "billRevisionRequest",
      );
    const revApproved = isRevResolvedByAdmin && bodyRev === null && prevBillRev;
    const revRejected =
      isRevResolvedByAdmin &&
      bodyRev &&
      typeof bodyRev === "object" &&
      String(bodyRev.status || "").toLowerCase() === "rejected";

    const lotPartyId = String(targetLotDoc?.partyId || "");
    if (isNewPendingBillRev) {
      const linkPath = `/party-ledger?lotId=${encodeURIComponent(String(lotId))}&billReview=1`;
      emitOrgChange(req, "partyEdit", {
        lotId: String(lotId),
        partyId: lotPartyId,
        adminOnly: !lotPartyId,
        action: "bill_revision_request",
        linkPath,
      });
    } else if (revApproved || revRejected) {
      const linkPath = `/party-ledger?lotId=${encodeURIComponent(String(lotId))}`;
      emitOrgChange(req, "partyEdit", {
        lotId: String(lotId),
        partyId: lotPartyId,
        adminOnly: !lotPartyId,
        action: revApproved ? "bill_revision_approved" : "bill_revision_rejected",
        linkPath,
      });
    } else {
      emitOrgChange(req, "partyEdit", {
        lotId: String(lotId),
        partyId: lotPartyId,
        adminOnly: !lotPartyId,
      });
    }

    res.json(serializePartyEditForUser(partyEdit.toObject(), req.user));

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
      if (lotForNotify) {
        void notifyBillRevisionRequest({
          lot: lotForNotify,
          ownerId: userId,
          fromAmount: bodyRev.fromAmount,
          toAmount: bodyRev.toAmount,
          reason: bodyRev.reason,
        });
      }
    } else if (revApproved || revRejected) {
      const lotForNotify = await loadLotForNotify();
      if (lotForNotify) {
        void notifyBillRevisionResolved({
          lot: lotForNotify,
          ownerId: userId,
          approved: Boolean(revApproved),
          fromAmount: prevBillRev?.fromAmount ?? bodyRev?.fromAmount,
          toAmount: prevBillRev?.toAmount ?? bodyRev?.toAmount,
          note: bodyRev?.rejectionNote,
        });
        void Notification.updateMany(
          { lotId: String(lotId), type: "bill_revision_request", readAt: null },
          { $set: { readAt: new Date() } }
        ).then((r) => {
          if (r?.modifiedCount > 0) {
            emitOrgChange(req, "notification", {
              action: "notifications_marked_read",
              targetUserId: String(req.user._id),
              lotId: String(lotId),
              category: "bill_revision",
            });
          }
        }).catch(() => {});
      }
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
