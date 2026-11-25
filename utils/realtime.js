const { getDataOwnerId } = require("./access");
const { clearCache } = require("./requestCache");

/** Socket.io room that contains an org's admin + all of its party users. */
const orgRoom = (ownerId) => `org:${String(ownerId)}`;

/** Socket.io room for a specific authenticated user (all active devices/tabs of that user). */
const userRoom = (userId) => `user:${String(userId)}`;

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
    const senderUserId = req.user._id ? String(req.user._id) : "";
    clearCache("bootstrap");

    const payload = {
      type: type || "data",
      ownerId: ownerId ? String(ownerId) : "",
      at: Date.now(),
      ...extra,
    };

    if (extra && extra.targetUserId) {
      const targetId = String(extra.targetUserId);
      io.to(userRoom(targetId)).emit("data:changed", payload);
      if (senderUserId && senderUserId !== targetId) {
        io.to(userRoom(senderUserId)).emit("data:changed", payload);
      }
      return;
    }
    if (ownerId) {
      io.to(orgRoom(ownerId)).emit("data:changed", payload);
    }
    if (senderUserId) {
      io.to(userRoom(senderUserId)).emit("data:changed", payload);
    }
  } catch {
    /* best-effort only */
  }
};

module.exports = { orgRoom, userRoom, emitOrgChange };
