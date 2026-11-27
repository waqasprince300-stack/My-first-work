const express = require("express");
const router = express.Router();
const Payment = require("../models/Payment");
const Party = require("../models/Party");
const {
  getBusinessOwnerFilter,
  getDataOwnerId,
  getOwnerFilter,
  getPartyPaymentOrConditions,
  isParty,
  requireAdminUser,
  isTenantAdmin,
  stripPrivatePaymentFieldsForParty,
  validateObjectIdParam,
} = require("../utils/access");
const { parsePaginationQuery, paginatedJson } = require("../utils/pagination");
const { emitOrgChange } = require("../utils/realtime");
const { notifyPaymentRecorded, notifyPaymentUpdated, notifyPaymentDeleted } = require("../utils/lotNotifications");

router.param("id", validateObjectIdParam);

const normalize = (doc) => ({ ...doc.toObject(), id: doc._id.toString() });
const stripOwnership = ({
  userId: _userId,
  businessOwnerId: _businessOwnerId,
  _id: _mongoId,
  id: _id,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  ...data
}) => data;

/** Keep hasReceipt in sync with the stored slip so list/bootstrap can flag rows without the blob. */
const withReceiptFlag = (data) => {
  if (Object.prototype.hasOwnProperty.call(data, "receipt")) {
    const isString = typeof data.receipt === "string";
    const receiptStr = isString ? data.receipt.trim() : "";
    data.hasReceipt = receiptStr !== "";
    
    if (data.hasReceipt) {
      if (!receiptStr.startsWith("data:image/") && !receiptStr.startsWith("data:application/pdf")) {
        throw new Error("Invalid receipt format. Must be an image or PDF data URI.");
      }
    }
  }
  return data;
};

const withPartyId = async (payload, userId) => {
  const data = { ...payload };
  if (
    !data.partyId &&
    data.party &&
    String(data.party).trim().toLowerCase() !== "owner"
  ) {
    const party = await Party.findOne({ userId, name: data.party });
    if (party) data.partyId = String(party._id);
  }
  return data;
};

// Get all payments
router.get("/", async (req, res) => {
  try {
    const allWorkspaces =
      String(req.query.scope || "").toLowerCase() === "all" &&
      isTenantAdmin(req.user);

    const partyAllBiz =
      String(req.query.partyScope || "").toLowerCase() === "all" &&
      isParty(req.user);

    let filter;
    if (isParty(req.user)) {
      const partyMatch = getPartyPaymentOrConditions(req.user);

      filter = {
        ...getOwnerFilter(req),
        ...(partyAllBiz ? {} : getBusinessOwnerFilter(req)),
        $or: partyMatch,
      };
    } else if (allWorkspaces) {
      filter = { ...getOwnerFilter(req) };
    } else {
      filter = { ...getOwnerFilter(req), ...getBusinessOwnerFilter(req) };
    }

    const typeQ = String(req.query.type || "").trim();
    if (typeQ) filter.type = typeQ;

    const bizOwnerQ = String(req.query.businessOwnerId || "").trim();
    if (bizOwnerQ) filter.businessOwnerId = bizOwnerQ;

    const partyKind = String(req.query.partyKind || "")
      .trim()
      .toLowerCase();
    if (partyKind === "owner") {
      filter.party = /^\s*owner\s*$/i;
    } else if (partyKind === "nonowner") {
      filter.party = { $not: /^\s*owner\s*$/i };
    }

    const pagination = parsePaginationQuery(req);
    const sort = { createdAt: -1 };
    // Slip images are excluded from list payloads (loaded lazily per row via GET /payments/:id).
    const listSelect = "-receipt";
    if (pagination.paginate) {
      const [rows, total] = await Promise.all([
        Payment.find(filter)
          .select(listSelect)
          .sort(sort)
          .skip(pagination.skip)
          .limit(pagination.limit)
          .lean(),
        Payment.countDocuments(filter),
      ]);
      const missingFlag = rows.filter((d) => d.hasReceipt !== true);
      let slipIds = new Set();
      if (missingFlag.length) {
        const withSlip = await Payment.find({
          _id: { $in: missingFlag.map((d) => d._id) },
          receipt: { $exists: true, $nin: ["", null] },
        })
          .select("_id")
          .lean();
        slipIds = new Set(withSlip.map((d) => String(d._id)));
      }
      return paginatedJson(
        res,
        rows.map((doc) => {
          const item = {
            ...doc,
            id: String(doc._id),
            hasReceipt: doc.hasReceipt === true || slipIds.has(String(doc._id)),
          };
          return isParty(req.user) ? stripPrivatePaymentFieldsForParty(item) : item;
        }),
        total,
        pagination.page,
        pagination.limit,
      );
    }

    const payments = await Payment.find(filter)
      .select(listSelect)
      .sort(sort)
      .lean();
    const missingFlag = payments.filter((d) => d.hasReceipt !== true);
    let slipIds = new Set();
    if (missingFlag.length) {
      const withSlip = await Payment.find({
        _id: { $in: missingFlag.map((d) => d._id) },
        receipt: { $exists: true, $nin: ["", null] },
      })
        .select("_id")
        .lean();
      slipIds = new Set(withSlip.map((d) => String(d._id)));
    }
    res.json(
      payments.map((doc) => {
        const item = {
          ...doc,
          id: String(doc._id),
          hasReceipt: doc.hasReceipt === true || slipIds.has(String(doc._id)),
        };
        return isParty(req.user) ? stripPrivatePaymentFieldsForParty(item) : item;
      }),
    );
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching payments", error: error.message });
  }
});

// Get single payment
router.get("/:id", async (req, res) => {
  try {
    // Party payments span every workspace (same as partyScope=all list). Do not filter by
    // businessOwnerId here — that made slips visible in the list but 404 on open.
    const filter = isParty(req.user)
      ? {
          _id: req.params.id,
          ...getOwnerFilter(req),
          $or: getPartyPaymentOrConditions(req.user),
        }
      : {
          _id: req.params.id,
          ...getOwnerFilter(req),
          ...getBusinessOwnerFilter(req),
        };
    const payment = await Payment.findOne(filter);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }
    const payload = normalize(payment);
    res.json(
      isParty(req.user) ? stripPrivatePaymentFieldsForParty(payload) : payload,
    );
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching payment", error: error.message });
  }
});

// Create payment
router.post("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const data = withReceiptFlag(
      await withPartyId(stripOwnership(req.body), userId),
    );
    const payment = new Payment({
      ...data,
      userId,
      businessOwnerId: req.businessOwnerId,
    });
    const saved = await payment.save();
    res.status(201).json(normalize(saved));
    const paymentObj = saved.toObject ? saved.toObject() : saved;
    const partyLabel = String(paymentObj.party || "")
      .trim()
      .toLowerCase();
    const isPartyPayment = partyLabel && partyLabel !== "owner";
    if (isPartyPayment) {
      const linkPath = "/payments";
      emitOrgChange(req, "payment", {
        paymentId: String(saved._id),
        action: "payment_recorded",
        linkPath,
        partyId: String(paymentObj.partyId || ""),
      });
      void notifyPaymentRecorded({ payment: paymentObj, ownerId: userId });
    } else {
      emitOrgChange(req, "payment", {
        paymentId: String(saved._id),
        adminOnly: true,
      });
    }
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error creating payment", error: error.message });
  }
});

// Update payment
router.patch("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const data = withReceiptFlag(
      await withPartyId(stripOwnership(req.body), userId),
    );
    const filter = {
      _id: req.params.id,
      userId,
      ...(req.businessOwnerId ? { businessOwnerId: req.businessOwnerId } : {}),
    };
    const payment = await Payment.findOneAndUpdate(
      filter,
      data,
      { new: true, runValidators: true },
    );
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }
    res.json(normalize(payment));
    const paymentObj = payment.toObject ? payment.toObject() : payment;
    const partyLabel = String(paymentObj.party || "").trim().toLowerCase();
    const isPartyPayment = Boolean(partyLabel && partyLabel !== "owner" && paymentObj.partyId);
    emitOrgChange(req, "payment", {
      paymentId: String(payment._id),
      action: "payment_updated",
      linkPath: "/payments",
      ...(isPartyPayment ? { partyId: String(paymentObj.partyId) } : { adminOnly: true }),
    });
    void notifyPaymentUpdated({ payment: paymentObj, ownerId: userId });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Error updating payment", error: error.message });
  }
});

// Delete payment
router.delete("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const filter = {
      _id: req.params.id,
      userId: getDataOwnerId(req.user),
      ...(req.businessOwnerId ? { businessOwnerId: req.businessOwnerId } : {}),
    };
    const payment = await Payment.findOneAndDelete(filter);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }
    res.json({ message: "Payment deleted successfully" });
    const paymentObj = payment.toObject ? payment.toObject() : payment;
    const partyLabel = String(paymentObj.party || "").trim().toLowerCase();
    const isPartyPayment = Boolean(partyLabel && partyLabel !== "owner" && paymentObj.partyId);
    emitOrgChange(req, "payment", {
      paymentId: String(payment._id),
      action: "payment_deleted",
      linkPath: "/payments",
      ...(isPartyPayment ? { partyId: String(paymentObj.partyId) } : { adminOnly: true }),
    });
    void notifyPaymentDeleted({ payment: paymentObj, ownerId: getDataOwnerId(req.user) });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting payment", error: error.message });
  }
});

module.exports = router;
