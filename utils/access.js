const mongoose = require('mongoose');
const BusinessOwner = require('../models/BusinessOwner');

const isTenantAdmin = (user) => user?.role === 'admin';
const isParty = (user) => user?.role === 'party';
const isAdmin = (user) => isTenantAdmin(user);

const getDataOwnerId = (user) => {
  if (isParty(user)) {
    return user.ownerId || user.approvedBy || user._id;
  }

  return user._id;
};

const getOwnerFilter = (req) => ({ userId: getDataOwnerId(req.user) });

const escapeRegexString = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Party portal: payments / lots that belong to this party across all collections.
 */
const getPartyPaymentOrConditions = (user) => {
  const pid = String(user.partyId || '');
  const pname = String(user.partyName || '').trim();
  const or = [];
  if (pid) or.push({ partyId: pid });
  if (pname) or.push({ party: new RegExp(`^${escapeRegexString(pname)}$`, 'i') });
  if (!or.length) return [{ partyId: '__impossible_party__' }];
  return or;
};

/** Lots assigned to this party user across every business workspace (matched by partyId or party name on the lot). */
const getPartyAllBusinessLotsFilter = (user) => {
  const userId = getDataOwnerId(user);
  const pname = String(user.partyName || '').trim();
  const pid = String(user.partyId || '').trim();
  const or = [];
  if (pid) or.push({ partyId: pid });
  if (pname) or.push({ partyName: new RegExp(`^${escapeRegexString(pname)}$`, 'i') });
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

  return { partyId: String(req.user.partyId || '') };
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

const ensureDefaultBusinessOwner = async (user) => {
  const userId = getDataOwnerId(user);
  let owner = await BusinessOwner.findOne({ userId, isDefault: true });

  if (!owner) {
    owner = await BusinessOwner.findOne({ userId }).sort({ createdAt: 1 });
  }

  if (!owner) {
    owner = await BusinessOwner.create({
      userId,
      name: 'Ghausia Collection',
      isDefault: true,
    });
  }

  const missingOwnerFilter = {
    userId,
    $or: [
      { businessOwnerId: { $exists: false } },
      { businessOwnerId: null },
    ],
  };
  const ownerUpdate = { $set: { businessOwnerId: owner._id } };
  const models = [
    require('../models/Collection'),
    require('../models/Party'),
    require('../models/GhausiaLot'),
    require('../models/Payment'),
    require('../models/PartyEdit'),
    require('../models/PartyLedger'),
    require('../models/RateCalculation'),
    require('../models/SavedDesign'),
  ];

  await Promise.all(models.map((Model) => Model.updateMany(missingOwnerFilter, ownerUpdate)));

  // Legacy rows may have businessOwnerId stored as "" — bypass Mongoose schema casting for this match
  const uid = userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId);
  const ownerId = owner._id instanceof mongoose.Types.ObjectId ? owner._id : new mongoose.Types.ObjectId(owner._id);
  await Promise.all(
    models.map((Model) =>
      Model.collection.updateMany(
        { userId: uid, businessOwnerId: '' },
        { $set: { businessOwnerId: ownerId } },
      ),
    ),
  );

  return owner;
};

const resolveBusinessOwner = async (req, res, next) => {
  try {
    const userId = getDataOwnerId(req.user);

    if (isParty(req.user)) {
      const headerBiz = (req.headers['x-business-owner-id'] || '').toString().trim();
      req.businessOwnerId =
        headerBiz || String(req.user.businessOwnerId != null ? req.user.businessOwnerId : '').trim();
      return next();
    }

    const requestedOwnerId = req.headers['x-business-owner-id'] || req.query.businessOwnerId;
    let owner = null;

    if (requestedOwnerId) {
      owner = await BusinessOwner.findOne({ _id: requestedOwnerId, userId, status: 'active' });
      if (!owner) {
        return res.status(404).json({ message: 'Business owner not found' });
      }
    } else {
      owner = await ensureDefaultBusinessOwner(req.user);
    }

    req.businessOwnerId = String(owner._id);
    next();
  } catch (error) {
    res.status(500).json({ message: 'Error resolving business owner', error: error.message });
  }
};

const requireAdminUser = (req, res) => {
  if (!isTenantAdmin(req.user)) {
    res.status(403).json({ message: 'Business admin access required' });
    return false;
  }

  return true;
};

const toObjectId = (value) => {
  if (!value) return value;
  if (value instanceof mongoose.Types.ObjectId) return value;
  return new mongoose.Types.ObjectId(value);
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
  toObjectId,
};
