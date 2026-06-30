const { getDataOwnerId } = require('./access');

/** Socket.io room that contains an org's admin + all of its party users. */
const orgRoom = (ownerId) => `org:${String(ownerId)}`;

/**
 * Notify every connected client in the same org (admin + parties) that data changed, so their
 * UI can refresh near-instantly (e.g. a party uploads a bill → admin's approval list updates).
 * Never throws — realtime is best-effort and must not break the API request.
 */
const emitOrgChange = (req, type, extra = {}) => {
  try {
    const io = req && req.io;
    if (!io || !req.user) return;
    const ownerId = getDataOwnerId(req.user);
    if (!ownerId) return;
    io.to(orgRoom(ownerId)).emit('data:changed', {
      type: type || 'data',
      ownerId: String(ownerId),
      at: Date.now(),
      ...extra,
    });
  } catch {
    /* best-effort only */
  }
};

module.exports = { orgRoom, emitOrgChange };
