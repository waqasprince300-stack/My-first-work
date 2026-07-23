const express = require("express");
const router = express.Router();
const GhausiaLot = require("../models/GhausiaLot");
const Party = require("../models/Party");
const Payment = require("../models/Payment");
const {
  getDataOwnerId,
  getScopedFilter,
  getPartyAllBusinessLotsFilter,
  getPartyPaymentOrConditions,
  isParty,
  isTenantAdmin,
} = require("../utils/access");

const normalizeStatusKey = (status) => {
  const s = String(status || "pending")
    .toLowerCase()
    .trim();
  if (s === "receivedback") return "received back";
  if (s === "inprogress") return "in progress";
  if (s === "pendingapproval") return "pending approval";
  return s;
};

const lotFilterForSummary = (req) => {
  const scopeAll =
    String(req.query.scope || "").toLowerCase() === "all" &&
    isTenantAdmin(req.user);
  if (isParty(req.user)) {
    return getPartyAllBusinessLotsFilter(req.user);
  }
  if (scopeAll) {
    return { userId: getDataOwnerId(req.user) };
  }
  return getScopedFilter(req);
};

const paymentFilterForSummary = (req) => {
  const scopeAll =
    String(req.query.scope || "").toLowerCase() === "all" &&
    isTenantAdmin(req.user);
  if (isParty(req.user)) {
    return {
      userId: getDataOwnerId(req.user),
      $or: getPartyPaymentOrConditions(req.user),
    };
  }
  if (scopeAll) {
    return { userId: getDataOwnerId(req.user) };
  }
  return getScopedFilter(req);
};

router.get("/summary", async (req, res) => {
  try {
    const lotFilter = lotFilterForSummary(req);
    const paymentFilter = paymentFilterForSummary(req);
    const userId = getDataOwnerId(req.user);

    const [statusAgg, paymentAgg, paymentDetailAgg, activePartyIds] =
      await Promise.all([
        GhausiaLot.aggregate([
          { $match: lotFilter },
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
              billAmount: { $sum: { $ifNull: ["$billAmount", 0] } },
            },
          },
        ]),
        Payment.aggregate([
          { $match: paymentFilter },
          {
            $group: {
              _id: "$type",
              total: { $sum: { $ifNull: ["$amount", 0] } },
              count: { $sum: 1 },
            },
          },
        ]),
        Payment.aggregate([
          { $match: paymentFilter },
          {
            $project: {
              type: 1,
              amount: { $ifNull: ["$amount", 0] },
              partyLower: {
                $toLower: {
                  $trim: { input: { $ifNull: ["$party", ""] } },
                },
              },
            },
          },
          {
            $group: {
              _id: {
                type: "$type",
                isOwner: { $eq: ["$partyLower", "owner"] },
              },
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        GhausiaLot.distinct("partyId", {
          ...lotFilter,
          partyId: { $exists: true, $nin: ["", null] },
        }),
      ]);

    const byStatus = {};
    let totalLots = 0;
    let totalLotValue = 0;
    statusAgg.forEach((row) => {
      const key = normalizeStatusKey(row._id);
      byStatus[key] = (byStatus[key] || 0) + Number(row.count || 0);
      totalLots += Number(row.count || 0);
      totalLotValue += Number(row.billAmount || 0);
    });

    const billableCount = byStatus["received back"] || 0;
    const billableTotal = statusAgg
      .filter((row) => normalizeStatusKey(row._id) === "received back")
      .reduce((sum, row) => sum + Number(row.billAmount || 0), 0);
    const completedTotal = statusAgg
      .filter((row) => normalizeStatusKey(row._id) === "completed")
      .reduce((sum, row) => sum + Number(row.billAmount || 0), 0);

    const ownerIn = paymentAgg
      .filter((row) => String(row._id) === "Received")
      .reduce((sum, row) => sum + Number(row.total || 0), 0);
    const paidOut = paymentAgg
      .filter((row) => String(row._id) === "Paid")
      .reduce((sum, row) => sum + Number(row.total || 0), 0);

    const partyPaidTotal = isParty(req.user) ? paidOut : 0;

    let receivedFromOwner = 0;
    let receivedFromParties = 0;
    let paidToNonOwnerParties = 0;
    let partyReceivedTotal = 0;
    let paymentCount = 0;

    paymentDetailAgg.forEach((row) => {
      const type = String(row._id?.type || "");
      const isOwner = Boolean(row._id?.isOwner);
      const total = Number(row.total || 0);
      const count = Number(row.count || 0);
      paymentCount += count;
      if (type === "Received" && isOwner) receivedFromOwner += total;
      if (type === "Received" && !isOwner) {
        receivedFromParties += total;
        if (isParty(req.user)) partyReceivedTotal += total;
      }
      if (type === "Paid" && !isOwner) paidToNonOwnerParties += total;
    });

    res.json({
      pipeline: {
        totalLots,
        pending: byStatus.pending || 0,
        dispatched: byStatus.dispatched || 0,
        pendingApproval: byStatus["pending approval"] || 0,
        rejected: byStatus.rejected || 0,
        receivedBack: byStatus["received back"] || 0,
        completed: byStatus.completed || 0,
        inProgress: byStatus["in progress"] || 0,
      },
      finance: {
        totalLotValue,
        billableTotal,
        billableCount,
        completedTotal,
        ownerIn,
        paidToParties: paidOut,
        netOwnerVsParties: ownerIn - paidOut,
        partyPaidTotal,
        receivedFromOwner,
        receivedFromParties,
        paidToNonOwnerParties,
        paymentCount,
        partyReceivedTotal,
        netBalance:
          receivedFromOwner + receivedFromParties - paidToNonOwnerParties,
      },
      parties: {
        activeWithLots: activePartyIds.filter(Boolean).length,
        totalParties: isParty(req.user)
          ? 1
          : await Party.countDocuments(
              String(req.query.scope || "").toLowerCase() === "all" &&
                isTenantAdmin(req.user)
                ? { userId }
                : getScopedFilter(req),
            ),
      },
    });
  } catch (error) {
    res
      .status(500)
      .json({
        message: "Error fetching dashboard summary",
        error: error.message,
      });
  }
});

module.exports = router;
