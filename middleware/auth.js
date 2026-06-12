const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getCached, setCached, invalidateCached } = require('../utils/requestCache');

const AUTH_USER_CACHE = 'authUser';
const AUTH_USER_TTL_MS = 60_000;
const AUTH_USER_FIELDS = [
  'name',
  'email',
  'phone',
  'role',
  'status',
  'partyId',
  'partyName',
  'ownerId',
  'approvedBy',
  'businessOwnerId',
  'pendingForAdminId',
];

const getJwtSecret = () => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required');
  }

  return 'development-jwt-secret-change-me';
};

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ message: 'Authentication token required' });
    }

    const decoded = jwt.verify(token, getJwtSecret());
    const userId = String(decoded.id || '');
    let user = getCached(AUTH_USER_CACHE, userId);

    if (!user) {
      user = await User.findById(decoded.id)
        .select(AUTH_USER_FIELDS.join(' '))
        .lean();
      if (user) {
        setCached(AUTH_USER_CACHE, userId, user, AUTH_USER_TTL_MS);
      }
    }

    if (!user) {
      return res.status(401).json({ message: 'User no longer exists' });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired authentication token' });
  }
};

const requireApproved = (req, res, next) => {
  if (req.user?.status !== 'approved') {
    return res.status(403).json({ message: 'Account is not approved yet' });
  }

  next();
};

/** Approved tenant (business) admin — manages businesses, parties, operational data. */
const requireTenantAdmin = (req, res, next) => {
  if (req.user?.status !== 'approved' || req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Business admin access required' });
  }

  next();
};

/** Platform super administrator — verifies organization admins. */
const requireSuperAdmin = (req, res, next) => {
  if (req.user?.status !== 'approved' || req.user?.role !== 'super_admin') {
    return res.status(403).json({ message: 'Super administrator access required' });
  }

  next();
};

/** @deprecated Use requireTenantAdmin */
const requireAdmin = requireTenantAdmin;

const invalidateAuthUserCache = (userId) => {
  if (userId != null && userId !== '') {
    invalidateCached(AUTH_USER_CACHE, String(userId));
  }
};

module.exports = authenticate;
module.exports.requireApproved = requireApproved;
module.exports.requireTenantAdmin = requireTenantAdmin;
module.exports.requireSuperAdmin = requireSuperAdmin;
module.exports.requireAdmin = requireAdmin;
module.exports.invalidateAuthUserCache = invalidateAuthUserCache;
