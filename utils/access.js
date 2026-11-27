const mongoose = require("mongoose");
const BusinessOwner = require("../models/BusinessOwner");
const { getCached, setCached } = require("./requestCache");

const BUSINESS_OWNER_CACHE = "businessOwner";
const BUSINESS_OWNER_TTL_MS = 30_000;

const isTenantAdmin = (user) => user?.role === "admin";
const isParty = (user) => user?.role === "party";
const isAdmin = (user) => isTenantAdmin(user);

const getDataOwnerId = (user) => {
  if (isParty(user)) {
    return user.ownerId || user.approvedBy || user._id;
  }

  return user._id;
};

const getOwnerFilter = (req) => ({ userId: getDataOwnerId(req.user) });

const escapeRegexString = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const legacyUnlinkedNameCondition = (field, pname) => {
  const clean = String(pname || "").trim();
  if (!clean || clean.toLowerCase() === "owner") return null;
  return {
    $and: [
      {
        $or: [
          { partyId: { $exists: false } },
          { partyId: null },
          { partyId: "" },
        ],
      },
      { [field]: new RegExp(`^\\s*${escapeRegexString(clean)}\\s*$`, "i") },
    ],
  };
};

/**
 * Party portal: payments / lots that belong to this party across all collections.
 * Only falls back to case-insensitive name matching on legacy records that lack a partyId.
 */
const getPartyPaymentOrConditions = (user) => {
  const pid = String(user.partyId || "").trim();
  const pname = String(user.partyName || "").trim();
  const or = [];
  if (pid) or.push({ partyId: pid });
  const legacyName = legacyUnlinkedNameCondition("party", pname);
  if (legacyName) or.push(legacyName);
  if (!or.length) return [{ partyId: "__impossible_party__" }];
  return or;
};

/** Lots assigned to this party user across every business workspace (strict partyId match + unlinked legacy name fallback). */
const getPartyAllBusinessLotsFilter = (user) => {
  const userId = getDataOwnerId(user);
  const pname = String(user.partyName || "").trim();
  const pid = String(user.partyId || "").trim();
  const or = [];
  if (pid) or.push({ partyId: pid });
  const legacyName = legacyUnlinkedNameCondition("partyName", pname);
  if (legacyName) or.push(legacyName);
  if (!or.length) return { userId, _id: { $in: [] } };
  return { userId, $or: or };
};

const getBusinessOwnerFilter = (req) => {
  if (!req.businessOwnerId) {
    return {};
  }

  return { businessOwnerId: req.businessOwnerId };
};

const getPartyScopeFilter = (req) => {
  if (!isParty(req.user)) {
    return {};
  }

  const pid = String(req.user.partyId || "").trim();
  return { partyId: pid || "__impossible_party__" };
};

const getScopedFilter = (req, extra = {}) => ({
  ...getOwnerFilter(req),
  ...getBusinessOwnerFilter(req),
  ...getPartyScopeFilter(req),
  ...extra,
});

/** Party portal: mutate/read a single lot — must match ledger list semantics (partyScope=all). */
const getPartyAccessibleLotFilter = (user, extra = {}) => ({
  ...getPartyAllBusinessLotsFilter(user),
  ...extra,
});

/**
 * One-time legacy backfill guard. The businessOwnerId migration only needs to run once per
 * tenant; after that we skip the heavy 9-collection scan so it never sits in the per-request path.
 */
const legacyMigrationDone = new Set();

const ensureDefaultBusinessOwner = async (user) => {
  const userId = getDataOwnerId(user);
  let owner = await BusinessOwner.findOne({ userId, isDefault: true, deletedAt: null }).lean();

  if (!owner) {
    owner = await BusinessOwner.findOne({ userId, deletedAt: null })
      .sort({ createdAt: 1 })
      .lean();
  }

  if (!owner) {
    return null;
  }

  // Migration already applied for this tenant in this process — skip the expensive scans.
  if (legacyMigrationDone.has(String(userId))) {
    return owner;
  }
  
  legacyMigrationDone.add(String(userId));

  // Run the legacy migration checks in the background so it doesn't block the request.
  (async () => {
    try {
      const missingOwnerFilter = {
        userId,
        $or: [{ businessOwnerId: { $exists: false } }, { businessOwnerId: null }],
      };
      const ownerUpdate = { $set: { businessOwnerId: owner._id } };
      const models = [
        require("../models/Collection"),
        require("../models/Party"),
        require("../models/GhausiaLot"),
        require("../models/Payment"),
        require("../models/PartyEdit"),
        require("../models/PartyLedger"),
        require("../models/RateCalculation"),
        require("../models/SavedDesign"),
      ];

      const migrationChecks = await Promise.all(
        models.map((Model) => Model.exists(missingOwnerFilter)),
      );
      if (migrationChecks.some(Boolean)) {
        await Promise.all(
          models.map((Model) => Model.updateMany(missingOwnerFilter, ownerUpdate)),
        );
      }

      // Legacy rows may have businessOwnerId stored as "" — bypass Mongoose schema casting for this match
      const uid =
        userId instanceof mongoose.Types.ObjectId
          ? userId
          : new mongoose.Types.ObjectId(userId);
      const ownerId =
        owner._id instanceof mongoose.Types.ObjectId
          ? owner._id
          : new mongoose.Types.ObjectId(owner._id);
      const legacyChecks = await Promise.all(
        models.map((Model) =>
          Model.collection.findOne(
            { userId: uid, businessOwnerId: "" },
            { projection: { _id: 1 } },
          ),
        ),
      );
      if (legacyChecks.some(Boolean)) {
        await Promise.all(
          models.map((Model) =>
            Model.collection.updateMany(
              { userId: uid, businessOwnerId: "" },
              { $set: { businessOwnerId: ownerId } },
            ),
          ),
        );
      }
    } catch (err) {
      console.error("Background legacy migration check failed:", err);
    }
  })();

  return owner;
};

const createBusinessOwnerResolver =
  ({ allowMissing = false, allowArchivedOnRead = false } = {}) =>
  async (req, res, next) => {
    try {
      const userId = getDataOwnerId(req.user);

      if (isParty(req.user)) {
        const headerBiz = (req.headers["x-business-owner-id"] || "")
          .toString()
          .trim();
        if (headerBiz && !mongoose.Types.ObjectId.isValid(headerBiz)) {
          return res.status(400).json({ message: "Invalid business owner id" });
        }
        req.businessOwnerId =
          headerBiz ||
          String(
            req.user.businessOwnerId != null ? req.user.businessOwnerId : "",
          ).trim();
        return next();
      }

      const requestedOwnerId =
        req.headers["x-business-owner-id"] || req.query.businessOwnerId;
      let owner = null;

      if (requestedOwnerId) {
        const cleanRequestedId = String(requestedOwnerId).trim();
        if (!mongoose.Types.ObjectId.isValid(cleanRequestedId)) {
          return res.status(400).json({ message: "Invalid business owner id" });
        }
        const allowArchived =
          allowArchivedOnRead &&
          (req.method === "GET" || req.method === "HEAD");
        const cacheKey = `${userId}:${cleanRequestedId}${allowArchived ? ":any" : ""}`;
        owner = getCached(BUSINESS_OWNER_CACHE, cacheKey);
        if (!owner) {
          const query = {
            _id: cleanRequestedId,
            userId,
            ...(allowArchived ? {} : { status: "active", deletedAt: null }),
          };
          owner = await BusinessOwner.findOne(query).lean();
          if (owner) {
            setCached(
              BUSINESS_OWNER_CACHE,
              cacheKey,
              owner,
              BUSINESS_OWNER_TTL_MS,
            );
          }
        }
        if (!owner) {
          return res.status(404).json({ message: "Business owner not found" });
        }
        req.businessOwnerId = String(owner._id);
      } else {
        const cacheKey = `${userId}:default`;
        owner = getCached(BUSINESS_OWNER_CACHE, cacheKey);
        if (!owner) {
          owner = await ensureDefaultBusinessOwner(req.user);
          if (owner) {
            setCached(
              BUSINESS_OWNER_CACHE,
              cacheKey,
              owner,
              BUSINESS_OWNER_TTL_MS,
            );
          }
        }
        if (!owner) {
          if (allowMissing) {
            req.businessOwnerId = null;
            return next();
          }
          return res.status(400).json({
            message:
              "Create a business workspace first. Open Work Spaces (Ghausia) and add a collection name before using this feature.",
            code: "NO_BUSINESS_OWNER",
          });
        }
        req.businessOwnerId = String(owner._id);
      }

      next();
    } catch (error) {
      res.status(500).json({
        message: "Error resolving business owner",
        error: error.message,
      });
    }
  };

const resolveBusinessOwner = createBusinessOwnerResolver();
const resolveBusinessOwnerAllowMissing = createBusinessOwnerResolver({
  allowMissing: true,
});
const resolveBusinessOwnerAllowArchivedRead = createBusinessOwnerResolver({
  allowMissing: true,
  allowArchivedOnRead: true,
});

const requireAdminUser = (req, res) => {
  if (!isTenantAdmin(req.user)) {
    res.status(403).json({ message: "Business admin access required" });
    return false;
  }

  return true;
};

const toObjectId = (value) => {
  if (!value) return value;
  if (value instanceof mongoose.Types.ObjectId) return value;
  return new mongoose.Types.ObjectId(value);
};

const validateObjectIdParam = (req, res, next, val) => {
  if (!mongoose.Types.ObjectId.isValid(String(val || "").trim())) {
    return res.status(400).json({ message: "Invalid id parameter" });
  }
  return next();
};

const PRIVATE_ADMIN_LOT_FIELDS = [
  "billAmount",
  "totalAmount",
  "rate",
  "ownerBillId",
  "billedInBillNo",
  "billedInBookNo",
  "ownerBillingChoice",
];

const stripPrivateLotFieldsForParty = (doc) => {
  if (!doc || typeof doc !== "object") return doc;
  const plain =
    typeof doc.toObject === "function" ? doc.toObject({ virtuals: true }) : { ...doc };
  for (const field of PRIVATE_ADMIN_LOT_FIELDS) {
    delete plain[field];
  }
  return plain;
};

/** Remove admin-internal bill tracking fields from PartyEdit docs before returning to party users. */
const stripPrivatePartyEditFieldsForParty = (doc) => {
  if (!doc || typeof doc !== "object") return doc;
  const plain =
    typeof doc.toObject === "function" ? doc.toObject({ virtuals: true }) : { ...doc };
  delete plain.amountChangeNote;
  delete plain.ghausiaAmount;
  if (plain.pendingRevision && typeof plain.pendingRevision === "object") {
    const rev = { ...plain.pendingRevision };
    delete rev.ghausiaAmount;
    plain.pendingRevision = rev;
  }
  return plain;
};

/** Remove internal owner-bill linkage metadata from Payment docs before returning to party users. */
const stripPrivatePaymentFieldsForParty = (doc) => {
  if (!doc || typeof doc !== "object") return doc;
  const plain =
    typeof doc.toObject === "function" ? doc.toObject({ virtuals: true }) : { ...doc };
  delete plain.ownerBillId;
  delete plain.billedInBillNo;
  delete plain.billedInBookNo;
  delete plain.isBillManualCash;
  delete plain.isLegacySettled;
  return plain;
};

/** Resolve the party-visible workspace name according to showWorkspace / workspaceAlias / workspaceOverrides. */
const resolvePartyWorkspaceLabel = (businessOwnerId, realName, partyDoc) => {
  const real = String(realName || "").trim();
  if (!partyDoc || typeof partyDoc !== "object") return real;
  const bizIdStr = String(businessOwnerId || "").trim();
  const globalAlias = String(partyDoc.workspaceAlias || "").trim();
  const overrides = Array.isArray(partyDoc.workspaceOverrides)
    ? partyDoc.workspaceOverrides
    : [];
  const ov = bizIdStr
    ? overrides.find(
        (o) => String(o?.businessOwnerId || "").trim() === bizIdStr,
      )
    : null;

  if (ov) {
    if (ov.showWorkspace !== false && String(ov.alias || "").trim()) {
      return String(ov.alias).trim();
    }
    if (ov.showWorkspace === false) {
      return globalAlias;
    }
  }
  if (partyDoc.showWorkspace === false) {
    return globalAlias;
  }
  if (globalAlias) {
    return globalAlias;
  }
  return real;
};

/** Keep only party-safe identity and workspace-visibility settings when serving Party docs to a party user. */
const sanitizePartyForParty = (doc) => {
  if (!doc || typeof doc !== "object") return doc;
  const plain =
    typeof doc.toObject === "function" ? doc.toObject({ virtuals: true }) : { ...doc };
  delete plain.totalDue;
  delete plain.totalPaid;
  delete plain.notes;
  return plain;
};

/** Cast string/array ObjectId fields so MongoDB aggregate $match behaves like Mongoose queries. */
const toAggregateObjectIdMatch = (
  filter = {},
  fields = ["userId", "businessOwnerId"],
) => {
  const out = { ...filter };
  for (const field of fields) {
    const val = out[field];
    if (typeof val === "string" && mongoose.Types.ObjectId.isValid(val)) {
      out[field] = new mongoose.Types.ObjectId(val);
    } else if (val && typeof val === "object" && Array.isArray(val.$in)) {
      out[field] = {
        ...val,
        $in: val.$in.map((v) =>
          typeof v === "string" && mongoose.Types.ObjectId.isValid(v)
            ? new mongoose.Types.ObjectId(v)
            : v,
        ),
      };
    }
  }
  return out;
};

module.exports = {
  getDataOwnerId,
  getBusinessOwnerFilter,
  getOwnerFilter,
  getPartyScopeFilter,
  getScopedFilter,
  getPartyAccessibleLotFilter,
  ensureDefaultBusinessOwner,
  escapeRegexString,
  getPartyAllBusinessLotsFilter,
  getPartyPaymentOrConditions,
  isAdmin,
  isTenantAdmin,
  isParty,
  requireAdminUser,
  resolveBusinessOwner,
  resolveBusinessOwnerAllowMissing,
  resolveBusinessOwnerAllowArchivedRead,
  stripPrivateLotFieldsForParty,
  stripPrivatePartyEditFieldsForParty,
  stripPrivatePaymentFieldsForParty,
  resolvePartyWorkspaceLabel,
  sanitizePartyForParty,
  toAggregateObjectIdMatch,
  toObjectId,
  validateObjectIdParam,
};
