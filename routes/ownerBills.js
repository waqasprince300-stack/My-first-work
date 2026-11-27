const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const OwnerBill = require("../models/OwnerBill");
const Payment = require("../models/Payment");
const GhausiaLot = require("../models/GhausiaLot");
const { getDataOwnerId, requireAdminUser } = require("../utils/access");
const { emitOrgChange } = require("../utils/realtime");
const { toDateOrNow, toIsoDateString } = require("../utils/dateHelpers");

const normalize = (doc) => ({ ...doc.toObject(), id: doc._id.toString() });

const isValidObjectId = (val) =>
  typeof val === "string"
    ? /^[0-9a-fA-F]{24}$/.test(val.trim())
    : mongoose.Types.ObjectId.isValid(val);

const formatLotLinkedKey = (item) => {
  const base = String(item?.lotNo || item?.lotNumber || "").trim();
  if (!base) return "";
  let key = base;
  if (
    item?.suitComponent === "dupatta" &&
    !key.endsWith("-D") &&
    !key.endsWith("(D)")
  ) {
    key = `${key}-D`;
  }
  if (item?.isRework && !/\(rework\)\s*$/i.test(key)) {
    key = `${key} (Rework)`;
  }
  return key;
};

const toSafeNum = (val) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
};

const sanitizeBillPayload = (body = {}) => {
  const bookNo = Math.max(1, Math.floor(toSafeNum(body.bookNo || 1)));
  const billNo = Math.max(1, Math.floor(toSafeNum(body.billNo || 1)));
  const date =
    String(body.date || "").trim() || toIsoDateString(new Date());
  const ownerName = String(body.ownerName || "").trim();
  const notes = String(body.notes || "");
  const status = body.status === "draft" ? "draft" : "finalized";

  const lots = (Array.isArray(body.lots) ? body.lots : []).map((l) => {
    const qty = Math.max(0, toSafeNum(l?.quantity));
    const rate = Math.max(0, toSafeNum(l?.rate));
    const amount = Math.max(0, toSafeNum(l?.amount));
    return {
      lotId: String(l?.lotId || l?.id || l._id || "").trim(),
      lotNo: String(l?.lotNo || l?.lotNumber || "").trim(),
      designNo: String(l?.designNo || "").trim(),
      suitComponent: String(l?.suitComponent || "main").trim(),
      isRework: Boolean(l?.isRework),
      quantity: qty,
      rate,
      amount,
      ...(l?.preBillRate != null ? { preBillRate: toSafeNum(l.preBillRate) } : {}),
      ...(l?.preBillAmount != null ? { preBillAmount: toSafeNum(l.preBillAmount) } : {}),
      note: String(l?.note || ""),
    };
  });

  const unpaidPreviousBills = (
    Array.isArray(body.unpaidPreviousBills) ? body.unpaidPreviousBills : []
  ).map((b) => ({
    billNo: String(b?.billNo || "").trim(),
    amount: Math.max(0, toSafeNum(b?.amount)),
    note: String(b?.note || ""),
  }));

  const paymentsReceived = (
    Array.isArray(body.paymentsReceived) ? body.paymentsReceived : []
  ).map((p) => ({
    paymentId: String(p?.paymentId || p?.id || p?._id || "").trim(),
    date: String(p?.date || "").trim() || date,
    amount: Math.max(0, toSafeNum(p?.amount)),
    note: String(p?.note || "Online / Cash received"),
  }));

  const deductions = (
    Array.isArray(body.deductions) ? body.deductions : []
  ).map((d) => ({
    title: String(d?.title || "Katoti").trim(),
    amount: Math.max(0, toSafeNum(d?.amount)),
  }));

  const sabqaBaqaya = toSafeNum(body.sabqaBaqaya);
  const currentBillTotal = lots.reduce((sum, l) => sum + l.amount, 0);
  const unpaidPreviousBillsTotal = unpaidPreviousBills.reduce(
    (sum, b) => sum + b.amount,
    0
  );
  const grossTotal = currentBillTotal + unpaidPreviousBillsTotal + sabqaBaqaya;
  const totalPaymentsReceived = paymentsReceived.reduce(
    (sum, p) => sum + p.amount,
    0
  );
  const subTotalAfterPayments = grossTotal - totalPaymentsReceived;
  const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);
  const grandTotalBaqaya = subTotalAfterPayments - totalDeductions;

  return {
    bookNo,
    billNo,
    date,
    ownerName,
    lots,
    currentBillTotal,
    unpaidPreviousBills,
    unpaidPreviousBillsTotal,
    sabqaBaqaya,
    grossTotal,
    paymentsReceived,
    totalPaymentsReceived,
    subTotalAfterPayments,
    deductions,
    totalDeductions,
    grandTotalBaqaya,
    notes,
    status,
  };
};

const bizScopeFilter = (bizId) => (bizId ? { businessOwnerId: bizId } : {});

const buildSingleLotFilter = (item, userId, bizId) => {
  const singleId = String(item?.lotId || item?._id || item?.id || "").trim();
  if (isValidObjectId(singleId)) {
    return {
      userId,
      _id: new mongoose.Types.ObjectId(singleId),
      ...bizScopeFilter(bizId),
    };
  }
  const singleNo = String(item?.lotNo || item?.lotNumber || "").trim();
  if (!singleNo) return null;
  const comp = String(item?.suitComponent || "main").trim();
  return {
    userId,
    $and: [
      bizScopeFilter(bizId),
      { $or: [{ lotNo: singleNo }, { lotNumber: singleNo }] },
      { suitComponent: comp === "dupatta" ? "dupatta" : { $ne: "dupatta" } },
      { isRework: item?.isRework ? true : { $ne: true } },
      { status: { $in: ["received back", "pending"] } },
    ],
  };
};

/**
 * Mark lots included in a finalized OwnerBill as `completed` (including combined Rs 0
 * dupatta child lots linked via `linkedLotId` so they don't remain stuck in Billable).
 * Returns resolved `_id`s and updates `item.isRework` / `preBillRate` / `preBillAmount`.
 */
async function markIncludedLotsForBill(bill, userId, bizId, now) {
  let modifiedLotsCount = 0;
  const protectedObjectIds = [];
  let billLotsMutated = false;

  for (const item of bill.lots || []) {
    const lotQuery = buildSingleLotFilter(item, userId, bizId);
    if (!lotQuery) continue;

    const targetLots = await GhausiaLot.find(lotQuery).select(
      "_id rate billAmount receivedBackDate completionApprovedAt suitComponent linkedLotId isRework ownerBillId",
    );
    for (const tLot of targetLots) {
      protectedObjectIds.push(tLot._id);
      if (item.preBillRate == null && String(tLot.ownerBillId || "") !== String(bill._id)) {
        item.preBillRate = Number(tLot.rate ?? 0);
        item.preBillAmount = Number(tLot.billAmount ?? 0);
        item.isRework = Boolean(tLot.isRework);
        billLotsMutated = true;
      }

      const itemRate = Number(item.rate || 0);
      const itemAmount = Number(item.amount || 0);
      const setPatch = {
        status: "completed",
        ownerBillId: bill._id,
        billedInBillNo: bill.billNo,
        billedInBookNo: bill.bookNo,
      };
      if (!tLot.completionApprovedAt) {
        setPatch.completionApprovedAt = now;
      }
      if (!tLot.receivedBackDate) {
        setPatch.receivedBackDate = toDateOrNow(bill.date);
      }
      if (itemRate > 0) setPatch.rate = itemRate;
      if (itemAmount > 0) {
        setPatch.billAmount = itemAmount;
        setPatch.totalAmount = itemAmount;
      }
      const uRes = await GhausiaLot.updateOne({ _id: tLot._id }, { $set: setPatch });
      modifiedLotsCount += uRes.modifiedCount || 0;

      // Complete combined Rs 0 dupatta child alongside parent Kameez lot
      if (tLot.suitComponent !== "dupatta" && tLot.linkedLotId) {
        const child = await GhausiaLot.findOne({
          _id: tLot.linkedLotId,
          userId,
          suitComponent: "dupatta",
        }).select("_id ownerBillingChoice billAmount receivedBackDate completionApprovedAt");
        if (
          child &&
          (child.ownerBillingChoice === "combined" || Number(child.billAmount || 0) === 0)
        ) {
          protectedObjectIds.push(child._id);
          const childPatch = {
            status: "completed",
            ownerBillId: bill._id,
            billedInBillNo: bill.billNo,
            billedInBookNo: bill.bookNo,
          };
          if (!child.completionApprovedAt) childPatch.completionApprovedAt = now;
          if (!child.receivedBackDate) childPatch.receivedBackDate = toDateOrNow(bill.date);
          const cu = await GhausiaLot.updateOne({ _id: child._id }, { $set: childPatch });
          modifiedLotsCount += cu.modifiedCount || 0;
        }
      }
    }
  }

  if (billLotsMutated) {
    await OwnerBill.updateOne({ _id: bill._id }, { $set: { lots: bill.lots } });
  }

  return { modifiedLotsCount, protectedObjectIds };
}

/** Restore pre-bill rate/billAmount on lots removed from or unlinked by deleting an OwnerBill. */
async function restoreRevertedLotsFromBill(queryFilter, bill) {
  const prevByLotId = new Map();
  for (const item of bill?.lots || []) {
    if (item?.lotId && item.preBillAmount != null) {
      prevByLotId.set(String(item.lotId), {
        rate: Number(item.preBillRate ?? 0),
        billAmount: Number(item.preBillAmount ?? 0),
      });
    }
  }

  const affectedLots = await GhausiaLot.find(queryFilter).select("_id").lean();
  for (const l of affectedLots) {
    const prev = prevByLotId.get(String(l._id));
    await GhausiaLot.updateOne(
      { _id: l._id },
      {
        $set: {
          status: "received back",
          ownerBillId: null,
          billedInBillNo: null,
          billedInBookNo: null,
          ...(prev
            ? {
                rate: prev.rate,
                billAmount: prev.billAmount,
                totalAmount: prev.billAmount,
              }
            : {}),
        },
      },
    );
  }
}

// 1. Get bills for owner / workspace + compute next defaults
router.get("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const filter = { userId };
    const bizId = req.businessOwnerId || req.query.businessOwnerId;
    if (bizId) {
      filter.businessOwnerId = bizId;
    }

    const bills = await OwnerBill.find(filter).sort({
      bookNo: -1,
      billNo: -1,
      createdAt: -1,
    });

    // Compute next defaults for this workspace/owner
    const nextDefaults = {
      nextBookNo: 1,
      nextBillNo: 1,
      lastSabqaBaqaya: 0,
      lastBillDate: null,
      lastBillId: null,
      billedPaymentIds: [],
    };

    const finalizedBills = bills.filter((b) => b.status !== "draft");
    if (finalizedBills.length > 0) {
      const latest = finalizedBills[0]; // newest finalized bill by (bookNo, billNo)
      const curBook = Number(latest.bookNo || 1);
      const curBillNo = Number(latest.billNo || 1);

      if (curBillNo >= 100) {
        nextDefaults.nextBookNo = curBook + 1;
        nextDefaults.nextBillNo = 1;
      } else {
        nextDefaults.nextBookNo = curBook;
        nextDefaults.nextBillNo = curBillNo + 1;
      }
      nextDefaults.lastSabqaBaqaya = Number(latest.grandTotalBaqaya || 0);
      nextDefaults.lastBillDate = latest.date || null;
      nextDefaults.lastBillId = String(latest._id);
    }

    // Collect all payment IDs that have already been settled in existing finalized bills or legacy history
    const billedPaymentIds = new Set();
    finalizedBills.forEach((b) => {
      (b.paymentsReceived || []).forEach((p) => {
        const pid = String(p.paymentId || p._id || p.id || "").trim();
        if (pid && isValidObjectId(pid)) billedPaymentIds.add(pid);
      });
    });

    try {
      const legacyPayments = await Payment.find({
        userId,
        ...(bizId ? { businessOwnerId: bizId } : {}),
        $or: [
          { isLegacySettled: true },
          { billedInBillNo: { $in: ["legacy_settled", "historical"] } },
        ],
      }).select("_id");
      legacyPayments.forEach((p) => billedPaymentIds.add(String(p._id)));
    } catch (legacyErr) {
      console.warn("Could not query legacy settled payments:", legacyErr.message);
    }

    nextDefaults.billedPaymentIds = Array.from(billedPaymentIds);

    res.json({
      bills: bills.map(normalize),
      nextDefaults,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching owner bills", error: error.message });
  }
});

// 2. Get single bill
router.get("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid bill id" });
    }
    const userId = getDataOwnerId(req.user);
    const filter = { _id: req.params.id, userId };
    const bizId = req.businessOwnerId || req.query.businessOwnerId;
    if (bizId) {
      filter.businessOwnerId = bizId;
    }
    const bill = await OwnerBill.findOne(filter);
    if (!bill) {
      return res.status(404).json({ message: "Bill not found" });
    }
    res.json(normalize(bill));
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching bill", error: error.message });
  }
});

// 3. Create new bill
router.post("/", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const bizId = req.businessOwnerId || req.body.businessOwnerId;

    if (!bizId) {
      return res.status(400).json({ message: "businessOwnerId is required" });
    }

    const cleanBody = sanitizeBillPayload(req.body);
    const existingBill = await OwnerBill.findOne({
      userId,
      businessOwnerId: bizId,
      bookNo: cleanBody.bookNo,
      billNo: cleanBody.billNo,
    });
    if (existingBill) {
      return res.status(409).json({
        message: `Bill #${cleanBody.billNo} (Book ${cleanBody.bookNo}) pehle se database mein mojood hai! Duplicate bill save nahi ho sakta.`,
      });
    }

    const bill = new OwnerBill({
      ...cleanBody,
      userId,
      businessOwnerId: bizId,
    });
    const saved = await bill.save();
    let billPaymentsUpdated = false;

    if (saved.status === "draft") {
      emitOrgChange(req, "owner_bill", {
        billId: String(saved._id),
        action: "owner_bill_created",
        adminOnly: true,
      });
      return res.status(201).json(normalize(saved));
    }

    // 1. Mark included lots (and combined Rs 0 dupatta children) as completed & link to this Owner Bill
    try {
      const { modifiedLotsCount } = await markIncludedLotsForBill(
        saved,
        userId,
        bizId,
        new Date(),
      );
      if (modifiedLotsCount > 0) {
        console.log(
          `[OwnerBill] Marked ${modifiedLotsCount} lots as completed for Bill #${saved.billNo}`
        );
        emitOrgChange(req, "lot", { action: "lots_billed", adminOnly: true });
      }
    } catch (lotErr) {
      console.warn("Could not mark lots as completed on bill save:", lotErr);
    }

    // 2. Link picked payments to this bill, and auto-create owner cash rows for manual cash entries
    try {
      const activePayments = saved.paymentsReceived || [];

      for (let i = 0; i < activePayments.length; i++) {
        const p = activePayments[i];
        const pid = String(p.paymentId || p.id || p._id || "").trim();
        if (pid && isValidObjectId(pid)) {
          try {
            await Payment.updateOne(
              { _id: new mongoose.Types.ObjectId(pid), userId },
              {
                $set: {
                  ownerBillId: saved._id,
                  billedInBillNo: saved.billNo,
                  billedInBookNo: saved.bookNo,
                },
              }
            );
          } catch (linkErr) {
            console.warn("Could not link existing payment:", linkErr.message);
          }
        } else if (Number(p.amount || 0) > 0) {
          try {
            const newPayment = await Payment.create({
              userId,
              businessOwnerId: bizId,
              type: "Received",
              amount: Number(p.amount),
              party: "Owner",
              date:
                toIsoDateString(p.date || saved.date) ||
                toIsoDateString(new Date()),
              note: p.note
                ? `${p.note} (Bill #${saved.billNo})`
                : `Cash received on Bill #${saved.billNo}`,
              ownerBillId: saved._id,
              billedInBillNo: saved.billNo,
              billedInBookNo: saved.bookNo,
              isBillManualCash: true,
            });
            p.paymentId = String(newPayment._id);
            billPaymentsUpdated = true;
          } catch (createPayErr) {
            console.warn(
              "Could not auto-create payment for bill manual cash:",
              createPayErr.message
            );
          }
        }
      }

      if (billPaymentsUpdated) {
        await OwnerBill.updateOne(
          { _id: saved._id },
          { $set: { paymentsReceived: activePayments } }
        );
      }
    } catch (payErr) {
      console.warn("Could not link payments on bill save:", payErr.message);
    }

    // 3. Record each lot billed to Owner in the Payments ledger
    try {
      for (const item of saved.lots || []) {
        const itemAmt = Number(item.amount || 0);
        if (itemAmt <= 0) continue;
        const itemLotNo = formatLotLinkedKey(item);
        if (!itemLotNo) continue;

        const existingLotPayment = await Payment.findOne({
          userId,
          businessOwnerId: bizId,
          type: "Paid",
          party: "Owner",
          linkedLot: itemLotNo,
          ownerBillId: saved._id,
        });

        if (!existingLotPayment) {
          await Payment.create({
            userId,
            businessOwnerId: bizId,
            type: "Paid",
            party: "Owner",
            amount: itemAmt,
            date: toIsoDateString(saved.date) || toIsoDateString(new Date()),
            linkedLot: itemLotNo,
            ownerBillId: saved._id,
            billedInBillNo: saved.billNo,
            billedInBookNo: saved.bookNo,
            note: item.note
              ? `Lot ${itemLotNo} billed to owner (Bill #${saved.billNo}) — ${item.note}`
              : `Lot ${itemLotNo} billed to owner (Bill #${saved.billNo}, Book ${saved.bookNo}) — Design: ${item.designNo || "—"}, Qty: ${item.quantity || 0}`,
          });
        }
      }
    } catch (lotPayErr) {
      console.warn(
        "Could not create lot payment records for bill:",
        lotPayErr.message
      );
    }

    // 4. Create Tally marker payment
    try {
      const tallyNote = `Bill Book ${saved.bookNo} - Bill #${saved.billNo} Finalized (Baqaya: Rs ${Number(saved.grandTotalBaqaya || 0).toLocaleString()})`;
      await Payment.create({
        userId,
        businessOwnerId: bizId,
        type: "Tally",
        amount: Number(saved.grandTotalBaqaya || 0),
        party: "Owner",
        date: saved.date,
        ownerBillId: saved._id,
        billedInBillNo: saved.billNo,
        billedInBookNo: saved.bookNo,
        note: tallyNote,
        linkedLot: `Bill #${saved.billNo}`,
      });
    } catch (tallyErr) {
      console.warn(
        "Could not create tally payment for bill:",
        tallyErr.message
      );
    }

    emitOrgChange(req, "payment", {
      action: "payment_recorded",
      linkPath: "/payments",
      adminOnly: true,
    });
    emitOrgChange(req, "owner_bill", {
      billId: String(saved._id),
      action: "owner_bill_created",
      adminOnly: true,
    });
    const finalBill = billPaymentsUpdated
      ? await OwnerBill.findById(saved._id)
      : saved;
    res.status(201).json(normalize(finalBill || saved));
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({
        message:
          "Yeh Bill number aur Book number pehle se database mein mojood hai!",
      });
    }
    res
      .status(400)
      .json({ message: "Error creating owner bill", error: error.message });
  }
});

// 4. Update bill
router.patch("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid bill id" });
    }
    const userId = getDataOwnerId(req.user);
    const bizFilter = req.businessOwnerId
      ? { businessOwnerId: req.businessOwnerId }
      : {};

    const prevBill = await OwnerBill.findOne({
      _id: req.params.id,
      userId,
      ...bizFilter,
    });
    if (!prevBill) {
      return res.status(404).json({ message: "Bill not found" });
    }

    // Merge incoming fields onto existing bill snapshot for clean partial or full edits
    const mergedRaw = {
      ...prevBill.toObject(),
      ...req.body,
    };
    const cleanBody = sanitizeBillPayload(mergedRaw);

    const conflict = await OwnerBill.findOne({
      userId,
      businessOwnerId: prevBill.businessOwnerId,
      bookNo: cleanBody.bookNo,
      billNo: cleanBody.billNo,
      _id: { $ne: prevBill._id },
    });
    if (conflict) {
      return res.status(409).json({
        message: `Bill #${cleanBody.billNo} (Book ${cleanBody.bookNo}) pehle se database mein mojood hai!`,
      });
    }

    const bill = await OwnerBill.findOneAndUpdate(
      { _id: prevBill._id, userId },
      { $set: cleanBody },
      { new: true, runValidators: true }
    );
    if (!bill) {
      return res.status(404).json({ message: "Bill not found" });
    }

    if (bill.status === "draft") {
      emitOrgChange(req, "owner_bill", {
        billId: String(bill._id),
        action: "owner_bill_updated",
        adminOnly: true,
      });
      return res.json(normalize(bill));
    }

    // 1. Sync Lots (mark active + combined children first so protectedObjectIds protects active children, then revert removed ones)
    try {
      const { protectedObjectIds } = await markIncludedLotsForBill(
        bill,
        userId,
        bill.businessOwnerId,
        new Date(),
      );

      await restoreRevertedLotsFromBill(
        {
          userId,
          $and: [
            bizScopeFilter(bill.businessOwnerId),
            {
              $or: [
                { ownerBillId: bill._id },
                {
                  billedInBillNo: prevBill.billNo,
                  billedInBookNo: prevBill.bookNo,
                },
              ],
            },
          ],
          _id: { $nin: protectedObjectIds },
        },
        prevBill,
      );

      // Sync Paid lot settlement rows for this bill (scoped cleanly with isRework via formatLotLinkedKey)
      const activePaidLotKeys = [];
      for (const item of bill.lots || []) {
        const itemAmt = Number(item.amount || 0);
        if (itemAmt <= 0) continue;
        const itemLotNo = formatLotLinkedKey(item);
        if (!itemLotNo) continue;
        activePaidLotKeys.push(itemLotNo);

        const existingLotPayment = await Payment.findOne({
          userId,
          businessOwnerId: bill.businessOwnerId,
          type: "Paid",
          party: "Owner",
          linkedLot: itemLotNo,
          ownerBillId: bill._id,
        });

        const nextNote = item.note
          ? `Lot ${itemLotNo} billed to owner (Bill #${bill.billNo}) — ${item.note}`
          : `Lot ${itemLotNo} billed to owner (Bill #${bill.billNo}, Book ${bill.bookNo}) — Design: ${item.designNo || "—"}, Qty: ${item.quantity || 0}`;

        if (!existingLotPayment) {
          await Payment.create({
            userId,
            businessOwnerId: bill.businessOwnerId,
            type: "Paid",
            party: "Owner",
            amount: itemAmt,
            date: toIsoDateString(bill.date) || toIsoDateString(new Date()),
            linkedLot: itemLotNo,
            ownerBillId: bill._id,
            billedInBillNo: bill.billNo,
            billedInBookNo: bill.bookNo,
            note: nextNote,
          });
        } else {
          existingLotPayment.amount = itemAmt;
          existingLotPayment.date =
            toIsoDateString(bill.date) || existingLotPayment.date;
          existingLotPayment.billedInBillNo = bill.billNo;
          existingLotPayment.billedInBookNo = bill.bookNo;
          existingLotPayment.note = nextNote;
          await existingLotPayment.save();
        }
      }

      // Remove Paid rows for lots that were removed from this bill
      await Payment.deleteMany({
        userId,
        businessOwnerId: bill.businessOwnerId,
        type: "Paid",
        ownerBillId: bill._id,
        linkedLot: { $nin: activePaidLotKeys },
      });

      emitOrgChange(req, "lot", { action: "lots_billed", adminOnly: true });
    } catch (patchLotErr) {
      console.warn("Could not sync lots on bill patch:", patchLotErr.message);
    }

    // 2. Sync Received payments safely
    let billPaymentsUpdated = false;
    try {
      const incomingPayments = bill.paymentsReceived || [];
      const activePayIds = [];

      for (let i = 0; i < incomingPayments.length; i++) {
        const p = incomingPayments[i];
        const pid = String(p.paymentId || p.id || p._id || "").trim();
        if (pid && isValidObjectId(pid)) {
          const objId = new mongoose.Types.ObjectId(pid);
          activePayIds.push(objId);

          // Update amount/date/note ONLY if this payment was auto-created inside the bill modal
          const existingPay = await Payment.findOne({ _id: objId, userId });
          if (existingPay) {
            existingPay.ownerBillId = bill._id;
            existingPay.billedInBillNo = bill.billNo;
            existingPay.billedInBookNo = bill.bookNo;
            const looksLikeManualBillCash =
              Boolean(existingPay.isBillManualCash) ||
              /^Cash received on Bill #|\(Bill #\d+\)$/i.test(
                String(existingPay.note || "").trim()
              );
            if (looksLikeManualBillCash) {
              existingPay.amount = Number(p.amount || 0);
              existingPay.date =
                toIsoDateString(p.date || bill.date) || existingPay.date;
              const cleanNote = String(p.note || "").trim();
              const alreadyTagged = new RegExp(
                `\\(Bill #${bill.billNo}\\)|Cash received on Bill #${bill.billNo}`,
                "i"
              ).test(cleanNote);
              existingPay.note = cleanNote
                ? alreadyTagged
                  ? cleanNote
                  : `${cleanNote} (Bill #${bill.billNo})`
                : `Cash received on Bill #${bill.billNo}`;
              existingPay.party = "Owner";
            }
            await existingPay.save();
          }
        } else if (Number(p.amount || 0) > 0) {
          const newPayment = await Payment.create({
            userId,
            businessOwnerId: bill.businessOwnerId,
            type: "Received",
            amount: Number(p.amount),
            party: "Owner",
            date:
              toIsoDateString(p.date || bill.date) ||
              toIsoDateString(new Date()),
            note: p.note
              ? `${p.note} (Bill #${bill.billNo})`
              : `Cash received on Bill #${bill.billNo}`,
            ownerBillId: bill._id,
            billedInBillNo: bill.billNo,
            billedInBookNo: bill.bookNo,
            isBillManualCash: true,
          });
          p.paymentId = String(newPayment._id);
          activePayIds.push(newPayment._id);
          billPaymentsUpdated = true;
        }
      }

      // Delete ONLY auto-created manual cash Received payments that were removed from this bill
      await Payment.deleteMany({
        userId,
        type: "Received",
        ownerBillId: bill._id,
        _id: { $nin: activePayIds },
        $or: [
          { isBillManualCash: true },
          {
            note: {
              $regex: new RegExp(
                `^Cash received on Bill #${prevBill.billNo}$|\\(Bill #${prevBill.billNo}\\)$`,
                "i"
              ),
            },
          },
        ],
      });

      // Unlink any pre-existing online/bank Received payments that were unselected from this bill
      await Payment.updateMany(
        {
          userId,
          type: "Received",
          $or: [
            { ownerBillId: bill._id },
            { billedInBillNo: prevBill.billNo, billedInBookNo: prevBill.bookNo },
          ],
          _id: { $nin: activePayIds },
        },
        {
          $set: {
            ownerBillId: null,
            billedInBillNo: null,
            billedInBookNo: null,
          },
        }
      );

      if (billPaymentsUpdated) {
        await OwnerBill.updateOne(
          { _id: bill._id },
          { $set: { paymentsReceived: incomingPayments } }
        );
      }
    } catch (paySyncErr) {
      console.warn(
        "Could not sync payments on bill patch:",
        paySyncErr.message
      );
    }

    // 3. Update or upsert corresponding Tally marker
    try {
      const tallyNote = `Bill Book ${bill.bookNo} - Bill #${bill.billNo} Finalized (Baqaya: Rs ${Number(bill.grandTotalBaqaya || 0).toLocaleString()})`;
      const existingTally = await Payment.findOneAndUpdate(
        {
          userId,
          businessOwnerId: bill.businessOwnerId,
          type: "Tally",
          $or: [
            { ownerBillId: bill._id },
            {
              linkedLot: `Bill #${prevBill.billNo}`,
              $or: [
                { billedInBookNo: prevBill.bookNo },
                { billedInBookNo: null },
              ],
            },
          ],
        },
        {
          $set: {
            amount: Number(bill.grandTotalBaqaya || 0),
            party: "Owner",
            date: bill.date,
            ownerBillId: bill._id,
            billedInBillNo: bill.billNo,
            billedInBookNo: bill.bookNo,
            linkedLot: `Bill #${bill.billNo}`,
            note: tallyNote,
          },
        },
        { new: true, runValidators: true }
      );
      if (!existingTally) {
        await Payment.create({
          userId,
          businessOwnerId: bill.businessOwnerId,
          type: "Tally",
          amount: Number(bill.grandTotalBaqaya || 0),
          party: "Owner",
          date: bill.date,
          ownerBillId: bill._id,
          billedInBillNo: bill.billNo,
          billedInBookNo: bill.bookNo,
          linkedLot: `Bill #${bill.billNo}`,
          note: tallyNote,
        });
      }
    } catch (tallyErr) {
      console.warn("Could not update tally on bill patch:", tallyErr.message);
    }

    emitOrgChange(req, "payment", {
      action: "payment_recorded",
      linkPath: "/payments",
      adminOnly: true,
    });
    emitOrgChange(req, "owner_bill", {
      billId: String(bill._id),
      action: "owner_bill_updated",
      adminOnly: true,
    });
    const finalBill = billPaymentsUpdated
      ? await OwnerBill.findById(bill._id)
      : bill;
    res.json(normalize(finalBill || bill));
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({
        message:
          "Yeh Bill number aur Book number pehle se database mein mojood hai!",
      });
    }
    res
      .status(400)
      .json({ message: "Error updating bill", error: error.message });
  }
});

// 5. Delete bill (safely unlinks pre-existing Received payments without deleting them)
router.delete("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid bill id" });
    }
    const userId = getDataOwnerId(req.user);
    const bizFilter = req.businessOwnerId
      ? { businessOwnerId: req.businessOwnerId }
      : {};

    const bill = await OwnerBill.findOneAndDelete({
      _id: req.params.id,
      userId,
      ...bizFilter,
    });
    if (!bill) {
      return res.status(404).json({ message: "Bill not found" });
    }

    // Delete ONLY auto-generated rows belonging strictly to this bill (Tally, Paid lot entries, and auto manual cash)
    try {
      await Payment.deleteMany({
        userId,
        businessOwnerId: bill.businessOwnerId,
        $or: [
          { type: "Tally", ownerBillId: bill._id },
          {
            type: "Tally",
            linkedLot: `Bill #${bill.billNo}`,
            ownerBillId: null,
            date: bill.date,
          },
          { type: "Paid", ownerBillId: bill._id },
          {
            type: "Paid",
            party: "Owner",
            billedInBillNo: bill.billNo,
            ownerBillId: null,
          },
          {
            type: "Received",
            ownerBillId: bill._id,
            $or: [
              { isBillManualCash: true },
              {
                note: {
                  $regex: new RegExp(
                    `^Cash received on Bill #${bill.billNo}$|\\(Bill #${bill.billNo}\\)$`,
                    "i"
                  ),
                },
              },
            ],
          },
        ],
      });
    } catch (cleanPayErr) {
      console.warn(
        "Could not delete auto bill payment entries:",
        cleanPayErr.message
      );
    }

    // Unlink all remaining pre-existing Received payments in this workspace so they become available again
    try {
      await Payment.updateMany(
        {
          userId,
          ...bizScopeFilter(bill.businessOwnerId),
          $or: [
            { ownerBillId: bill._id },
            { billedInBillNo: bill.billNo, billedInBookNo: bill.bookNo },
          ],
        },
        {
          $set: {
            ownerBillId: null,
            billedInBillNo: null,
            billedInBookNo: null,
          },
        }
      );
    } catch (unlinkErr) {
      console.warn(
        "Could not unlink payments on bill delete:",
        unlinkErr.message
      );
    }

    // Revert lots (and pre-bill amounts) strictly linked to this bill back to 'received back' (billable)
    try {
      await restoreRevertedLotsFromBill(
        {
          userId,
          $and: [
            bizScopeFilter(bill.businessOwnerId),
            {
              $or: [
                { ownerBillId: bill._id },
                {
                  billedInBillNo: bill.billNo,
                  billedInBookNo: bill.bookNo,
                },
              ],
            },
          ],
        },
        bill,
      );
      emitOrgChange(req, "lot", { action: "lots_unbilled", adminOnly: true });
    } catch (revertErr) {
      console.warn("Could not revert lots on bill delete:", revertErr.message);
    }

    emitOrgChange(req, "owner_bill", {
      billId: String(bill._id),
      action: "owner_bill_deleted",
      adminOnly: true,
    });
    emitOrgChange(req, "payment", {
      action: "payment_deleted",
      linkPath: "/payments",
      adminOnly: true,
    });
    res.json({ message: "Bill deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting bill", error: error.message });
  }
});

module.exports = router;
