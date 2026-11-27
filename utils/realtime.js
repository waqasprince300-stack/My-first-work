const { getDataOwnerId } = require("./access");
const { clearCache } = require("./requestCache");

/** Socket.io room helpers — separate admin, targeted party, all-parties (global announcements only), and user rooms. */
const orgRoom = (ownerId) => `org:${String(ownerId)}`;
const adminRoom = (ownerId) => `admin:${String(ownerId)}`;
const partyRoom = (ownerId, partyId) =>
  `party:${String(ownerId)}:${String(partyId)}`;
const allPartiesRoom = (ownerId) => `parties:${String(ownerId)}`;
const userRoom = (userId) => `user:${String(userId)}`;

/** Disconnect every active socket held by a specific user (after disable/delete). */
const disconnectUserSockets = (io, userId) => {
  try {
    if (!io || !userId) return;
    io.in(userRoom(userId)).disconnectSockets(true);
  } catch {
    /* best-effort only */
  }
};

/**
 * Notify connected clients with strict tenant and party privacy isolation:
 * - `targetUserId`: sent only to that user's room.
 * - `broadcastTargetPartyId`: sent to adminRoom + ("all" -> allPartiesRoom | specific -> partyRoom).
 * - `partyId` (without `adminOnly`): sent to adminRoom + that party's room (and minimal unassign signal to `previousPartyId`).
 * - Default / `adminOnly`: sent strictly to `adminRoom(ownerId)` (fail-closed so party sockets never get admin/other-party events).
 * Includes `actorUserId` so the originating browser tab ignores its own write echo.
 */
const emitOrgChange = (req, type, extra = {}) => {
  try {
    const io = req && req.io;
    if (!io || !req.user) return;
    const ownerId = getDataOwnerId(req.user);
    const senderUserId = req.user._id ? String(req.user._id) : "";
    clearCache("bootstrap");

    const {
      adminOnly = false,
      previousPartyId = "",
      broadcastTargetPartyId = "",
      ...restExtra
    } = extra || {};

    const payload = {
      type: type || "data",
      ownerId: ownerId ? String(ownerId) : "",
      actorUserId: senderUserId,
      at: Date.now(),
      ...restExtra,
    };

    if (extra && extra.targetUserId) {
      const targetId = String(extra.targetUserId);
      io.to(userRoom(targetId)).emit("data:changed", payload);
      return;
    }

    if (!ownerId) {
      if (senderUserId) io.to(userRoom(senderUserId)).emit("data:changed", payload);
      return;
    }

    if (broadcastTargetPartyId) {
      io.to(adminRoom(ownerId)).emit("data:changed", payload);
      if (broadcastTargetPartyId === "all") {
        io.to(allPartiesRoom(ownerId)).emit("data:changed", payload);
      } else {
        io.to(partyRoom(ownerId, broadcastTargetPartyId)).emit("data:changed", payload);
      }
      return;
    }

    io.to(adminRoom(ownerId)).emit("data:changed", payload);

    const cleanPartyId = String(extra?.partyId || "").trim();
    if (!adminOnly && cleanPartyId && cleanPartyId.toLowerCase() !== "owner") {
      io.to(partyRoom(ownerId, cleanPartyId)).emit("data:changed", payload);
    }

    const cleanPrevPartyId = String(previousPartyId || "").trim();
    if (
      cleanPrevPartyId &&
      cleanPrevPartyId !== cleanPartyId &&
      cleanPrevPartyId.toLowerCase() !== "owner"
    ) {
      io.to(partyRoom(ownerId, cleanPrevPartyId)).emit("data:changed", {
        type: type || "data",
        ownerId: String(ownerId),
        actorUserId: senderUserId,
        at: payload.at,
        lotId: payload.lotId || "",
        action: "lot_unassigned",
      });
    }
  } catch {
    /* best-effort only */
  }
};

module.exports = {
  orgRoom,
  adminRoom,
  partyRoom,
  allPartiesRoom,
  userRoom,
  disconnectUserSockets,
  emitOrgChange,
};
