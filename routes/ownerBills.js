const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const OwnerBill = require("../models/OwnerBill");
const Payment = require("../models/Payment");
const GhausiaLot = require("../models/GhausiaLot");
const {
  getDataOwnerId,
  requireAdminUser,
} = require("../utils/access");
const { emitOrgChange } = require("../utils/realtime");
const { toDateOrNull, toDateOrNow, toIsoDateString } = require("../utils/dateHelpers");

const normalize = (doc) => ({ ...doc.toObject(), id: doc._id.toString() });

// 1. Get bills for owner / workspace + compute next defaults
router.get("/", async (req, res) => {
  try {
    const userId = getDataOwnerId(req.user);
    const filter = { userId };
    const bizId = req.businessOwnerId || req.query.businessOwnerId;
    if (bizId) {
      filter.businessOwnerId = bizId;
    }

    const bills = await OwnerBill.find(filter).sort({ bookNo: -1, billNo: -1, createdAt: -1 });

    // Compute next defaults for this workspace/owner
    let nextDefaults = {
      nextBookNo: 1,
      nextBillNo: 1,
      lastSabqaBaqaya: 0,
      lastBillDate: null,
      lastBillId: null,
      billedPaymentIds: [],
    };

    if (bills.length > 0) {
      const latest = bills[0]; // newest bill
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
    bills.forEach((b) => {
      (b.paymentsReceived || []).forEach((p) => {
        const pid = String(p.paymentId || p._id || p.id || "").trim();
        if (pid && pid.length === 24) billedPaymentIds.add(pid);
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
    } catch (_) {}

    nextDefaults.billedPaymentIds = Array.from(billedPaymentIds);

    res.json({
      bills: bills.map(normalize),
      nextDefaults,
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching owner bills", error: error.message });
  }
});

// 2. Get single bill
router.get("/:id", async (req, res) => {
  try {
    const userId = getDataOwnerId(req.user);
    const bill = await OwnerBill.findOne({ _id: req.params.id, userId });
    if (!bill) {
      return res.status(404).json({ message: "Bill not found" });
    }
    res.json(normalize(bill));
  } catch (error) {
    res.status(500).json({ message: "Error fetching bill", error: error.message });
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

    const checkBookNo = Number(req.body.bookNo || 1);
    const checkBillNo = Number(req.body.billNo || 1);
    const existingBill = await OwnerBill.findOne({
      userId,
      businessOwnerId: bizId,
      bookNo: checkBookNo,
      billNo: checkBillNo,
    });
    if (existingBill) {
      return res.status(409).json({
        message: `Bill #${checkBillNo} (Book ${checkBookNo}) pehle se database mein mojood hai! Duplicate bill save nahi ho sakta.`,
      });
    }

    const payload = {
      ...req.body,
      userId,
      businessOwnerId: bizId,
    };

    const bill = new OwnerBill(payload);
    const saved = await bill.save();

    // 1. Mark included lots as completed and link them to this Owner Bill
    try {
      const lotIds = (saved.lots || [])
        .map((l) => l.lotId || l._id || l.id)
        .filter((id) => id && String(id).length === 24);
      const lotNumbers = (saved.lots || [])
        .map((l) => String(l.lotNo || l.lotNumber || "").trim())
        .filter(Boolean);

      const conditions = [];
      if (lotIds.length > 0) {
        const objectIds = lotIds.map((id) => {
          try {
            return new mongoose.Types.ObjectId(id);
          } catch (_) {
            return id;
          }
        });
        conditions.push({ _id: { $in: objectIds } });
      }
      if (lotNumbers.length > 0) {
        conditions.push({ lotNo: { $in: lotNumbers } });
        conditions.push({ lotNumber: { $in: lotNumbers } });
      }

      if (conditions.length > 0) {
        const lotQuery = {
          userId,
          $and: [
            { $or: conditions },
            {
              $or: [
                { businessOwnerId: bizId },
                { businessOwnerId: null },
                { businessOwnerId: { $exists: false } },
              ],
            },
          ],
        };

        const updateRes = await GhausiaLot.updateMany(
          lotQuery,
          {
            $set: {
              status: "completed",
              ownerBillId: saved._id,
              billedInBillNo: saved.billNo,
              billedInBookNo: saved.bookNo,
              completionApprovedAt: new Date(),
              receivedBackDate: toDateOrNow(saved.date),
            },
          }
        );
        console.log(`[OwnerBill] Marked ${updateRes.modifiedCount} lots as completed for Bill #${saved.billNo}`);

        // Sync individual rate / billAmount onto GhausiaLot for any lot updated on this bill
        for (const item of (saved.lots || [])) {
          const itemRate = Number(item.rate || 0);
          const itemAmount = Number(item.amount || 0);
          if (itemRate <= 0 && itemAmount <= 0) continue;

          const singleConds = [];
          const singleId = item.lotId || item._id || item.id;
          if (singleId && String(singleId).length === 24) {
            try {
              singleConds.push({ _id: new mongoose.Types.ObjectId(singleId) });
            } catch (_) {}
          }
          const singleNo = String(item.lotNo || item.lotNumber || "").trim();
          if (singleNo) {
            singleConds.push({ lotNo: singleNo });
            singleConds.push({ lotNumber: singleNo });
          }
          if (singleConds.length === 0) continue;

          const rateUpdate = {};
          if (itemRate > 0) rateUpdate.rate = itemRate;
          if (itemAmount > 0) {
            rateUpdate.billAmount = itemAmount;
            rateUpdate.totalAmount = itemAmount;
          }

          await GhausiaLot.updateMany(
            {
              userId,
              $and: [
                { $or: singleConds },
                {
                  $or: [
                    { businessOwnerId: bizId },
                    { businessOwnerId: null },
                    { businessOwnerId: { $exists: false } },
                  ],
                },
              ],
            },
            { $set: rateUpdate }
          );
        }

        emitOrgChange(req, "lot", { action: "lots_billed" });
      }
    } catch (lotErr) {
      console.warn("Could not mark lots as completed on bill save:", lotErr);
    }

    // 2. Link included payments to this bill so they aren't double-deducted,
    // and auto-create payment records in the main ledger for any manual cash entries entered on this bill
    try {
      const activePayments = saved.paymentsReceived || [];
      let billPaymentsUpdated = false;

      for (let i = 0; i < activePayments.length; i++) {
        const p = activePayments[i];
        const pid = String(p.paymentId || p.id || p._id || "").trim();
        if (pid && pid.length === 24) {
          try {
            await Payment.updateOne(
              { _id: new mongoose.Types.ObjectId(pid), userId },
              {
                $set: {
                  ownerBillId: saved._id,
                  billedInBillNo: saved.billNo,
                },
              }
            );
          } catch (_) {}
        } else if (Number(p.amount || 0) > 0) {
          try {
            const newPayment = await Payment.create({
              userId,
              businessOwnerId: bizId,
              type: "Received",
              amount: Number(p.amount),
              party: saved.ownerName || "Owner",
              date: toIsoDateString(p.date || saved.date) || toIsoDateString(new Date()),
              note: p.note ? `${p.note} (Bill #${saved.billNo})` : `Cash received on Bill #${saved.billNo}`,
              ownerBillId: saved._id,
              billedInBillNo: saved.billNo,
            });
            p.paymentId = String(newPayment._id);
            billPaymentsUpdated = true;
          } catch (createPayErr) {
            console.warn("Could not auto-create payment for bill manual cash:", createPayErr.message);
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

    // 3. Record each lot billed to Owner in the Payments ledger so it shows on the Payments page under "Bill to Owner"
    try {
      for (const item of (saved.lots || [])) {
        const itemAmt = Number(item.amount || 0);
        if (itemAmt <= 0) continue;
        const itemLotNo = String(item.lotNo || item.lotNumber || '').trim();
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
            note: item.note
              ? `Lot ${itemLotNo} billed to owner (Bill #${saved.billNo}) — ${item.note}`
              : `Lot ${itemLotNo} billed to owner (Bill #${saved.billNo}, Book ${saved.bookNo}) — Design: ${item.designNo || '—'}, Qty: ${item.quantity || 0}`,
          });
        }
      }
    } catch (lotPayErr) {
      console.warn("Could not create lot payment records for bill:", lotPayErr.message);
    }

    // 4. Create a Tally marker payment so the ledger timeline reflects this finalized bill
    try {
      const tallyNote = `Bill Book ${saved.bookNo} - Bill #${saved.billNo} Finalized (Baqaya: Rs ${Number(saved.grandTotalBaqaya || 0).toLocaleString()})`;
      await Payment.create({
        userId,
        businessOwnerId: bizId,
        type: "Tally",
        amount: Number(saved.grandTotalBaqaya || 0),
        party: saved.ownerName || "Owner",
        date: saved.date,
        ownerBillId: saved._id,
        billedInBillNo: saved.billNo,
        note: tallyNote,
        linkedLot: `Bill #${saved.billNo}`,
      });
      emitOrgChange(req, "payment", { action: "payment_recorded", linkPath: "/payments" });
    } catch (tallyErr) {
      console.warn("Could not create tally payment for bill:", tallyErr.message);
    }

    emitOrgChange(req, "owner_bill", { billId: String(saved._id), action: "owner_bill_created" });
    const finalBill = billPaymentsUpdated
      ? await OwnerBill.findById(saved._id)
      : saved;
    res.status(201).json(normalize(finalBill || saved));
  } catch (error) {
    res.status(400).json({ message: "Error creating owner bill", error: error.message });
  }
});

// 4. Update bill
router.patch("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);

    const bill = await OwnerBill.findOneAndUpdate(
      { _id: req.params.id, userId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!bill) {
      return res.status(404).json({ message: "Bill not found" });
    }

    if (req.body.lots && Array.isArray(req.body.lots)) {
      try {
        const activeLotIds = req.body.lots
          .map((l) => l.lotId || l._id || l.id)
          .filter((id) => id && String(id).length === 24);
        const activeLotNos = req.body.lots
          .map((l) => String(l.lotNo || l.lotNumber || "").trim())
          .filter(Boolean);

        const objectActiveIds = activeLotIds.map((id) => {
          try {
            return new mongoose.Types.ObjectId(id);
          } catch (_) {
            return id;
          }
        });

        const bizCond = {
          $or: [
            { businessOwnerId: bill.businessOwnerId },
            { businessOwnerId: null },
            { businessOwnerId: { $exists: false } },
          ],
        };

        // Revert any lot previously linked to this bill that was removed in edit
        await GhausiaLot.updateMany(
          {
            userId,
            $and: [
              bizCond,
              {
                $or: [
                  { ownerBillId: bill._id },
                  { billedInBillNo: bill.billNo, billedInBookNo: bill.bookNo },
                ],
              },
            ],
            _id: { $nin: objectActiveIds },
            ...(activeLotNos.length > 0
              ? { lotNo: { $nin: activeLotNos }, lotNumber: { $nin: activeLotNos } }
              : {}),
          },
          {
            $set: {
              status: "received back",
              ownerBillId: null,
              billedInBillNo: null,
              billedInBookNo: null,
            },
          }
        );

        // Mark all active lots as completed
        const markConditions = [];
        if (objectActiveIds.length > 0) markConditions.push({ _id: { $in: objectActiveIds } });
        if (activeLotNos.length > 0) {
          markConditions.push({ lotNo: { $in: activeLotNos } });
          markConditions.push({ lotNumber: { $in: activeLotNos } });
        }
        if (markConditions.length > 0) {
          await GhausiaLot.updateMany(
            {
              userId,
              $and: [
                bizCond,
                { $or: markConditions },
              ],
            },
            {
              $set: {
                status: "completed",
                ownerBillId: bill._id,
                billedInBillNo: bill.billNo,
                billedInBookNo: bill.bookNo,
                completionApprovedAt: new Date(),
              },
            }
          );

          // Sync individual rate / billAmount onto GhausiaLot
          for (const item of req.body.lots) {
            const itemRate = Number(item.rate || 0);
            const itemAmount = Number(item.amount || 0);
            if (itemRate <= 0 && itemAmount <= 0) continue;

            const singleConds = [];
            const singleId = item.lotId || item._id || item.id;
            if (singleId && String(singleId).length === 24) {
              try {
                singleConds.push({ _id: new mongoose.Types.ObjectId(singleId) });
              } catch (_) {}
            }
            const singleNo = String(item.lotNo || item.lotNumber || "").trim();
            if (singleNo) {
              singleConds.push({ lotNo: singleNo });
              singleConds.push({ lotNumber: singleNo });
            }
            if (singleConds.length === 0) continue;

            const rateUpdate = {};
            if (itemRate > 0) rateUpdate.rate = itemRate;
            if (itemAmount > 0) {
              rateUpdate.billAmount = itemAmount;
              rateUpdate.totalAmount = itemAmount;
            }

            await GhausiaLot.updateMany(
              {
                userId,
                $and: [
                  bizCond,
                  { $or: singleConds },
                ],
              },
              { $set: rateUpdate }
            );
          }
        }
        // Sync lot payment records for Owner ledger
        try {
          for (const item of (bill.lots || [])) {
            const itemAmt = Number(item.amount || 0);
            if (itemAmt <= 0) continue;
            const itemLotNo = String(item.lotNo || item.lotNumber || '').trim();
            if (!itemLotNo) continue;

            const existingLotPayment = await Payment.findOne({
              userId,
              businessOwnerId: bill.businessOwnerId,
              type: "Paid",
              party: "Owner",
              linkedLot: itemLotNo,
              ownerBillId: bill._id,
            });

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
                note: item.note
                  ? `Lot ${itemLotNo} billed to owner (Bill #${bill.billNo}) — ${item.note}`
                  : `Lot ${itemLotNo} billed to owner (Bill #${bill.billNo}, Book ${bill.bookNo}) — Design: ${item.designNo || '—'}, Qty: ${item.quantity || 0}`,
              });
            } else if (existingLotPayment.amount !== itemAmt) {
              existingLotPayment.amount = itemAmt;
              await existingLotPayment.save();
            }
          }
        } catch (lotPayErr) {
          console.warn("Could not sync lot payments on bill patch:", lotPayErr.message);
        }

        emitOrgChange(req, "lot", { action: "lots_billed" });
      } catch (patchLotErr) {
        console.warn("Could not sync lots on bill patch:", patchLotErr.message);
      }
    }

    // Sync payments if updated
    if (req.body.paymentsReceived && Array.isArray(req.body.paymentsReceived)) {
      try {
        const incomingPayments = req.body.paymentsReceived;
        const activePayIds = [];
        let billPaymentsUpdated = false;

        for (let i = 0; i < incomingPayments.length; i++) {
          const p = incomingPayments[i];
          const pid = String(p.paymentId || p.id || p._id || "").trim();
          if (pid && pid.length === 24) {
            try {
              const objId = new mongoose.Types.ObjectId(pid);
              activePayIds.push(objId);
            } catch (_) {}
          } else if (Number(p.amount || 0) > 0) {
            try {
              const newPayment = await Payment.create({
                userId,
                businessOwnerId: bill.businessOwnerId,
                type: "Received",
                amount: Number(p.amount),
                party: bill.ownerName || "Owner",
                date: toIsoDateString(p.date || bill.date) || toIsoDateString(new Date()),
                note: p.note ? `${p.note} (Bill #${bill.billNo})` : `Cash received on Bill #${bill.billNo}`,
                ownerBillId: bill._id,
                billedInBillNo: bill.billNo,
              });
              p.paymentId = String(newPayment._id);
              activePayIds.push(newPayment._id);
              billPaymentsUpdated = true;
            } catch (createPayErr) {
              console.warn("Could not auto-create payment for bill manual cash on patch:", createPayErr.message);
            }
          }
        }

        // Delete manual payments created for this bill that were removed
        await Payment.deleteMany({
          userId,
          ownerBillId: bill._id,
          note: { $regex: new RegExp(`\\(Bill #${bill.billNo}\\)|Bill #${bill.billNo}`, 'i') },
          _id: { $nin: activePayIds },
        });

        // Unlink other removed payments
        await Payment.updateMany(
          {
            userId,
            $or: [
              { ownerBillId: bill._id },
              { billedInBillNo: bill.billNo },
            ],
            _id: { $nin: activePayIds },
          },
          {
            $set: {
              ownerBillId: null,
              billedInBillNo: null,
            },
          }
        );

        // Link active payments
        if (activePayIds.length > 0) {
          await Payment.updateMany(
            { userId, _id: { $in: activePayIds } },
            {
              $set: {
                ownerBillId: bill._id,
                billedInBillNo: bill.billNo,
              },
            }
          );
        }

        if (billPaymentsUpdated) {
          await OwnerBill.updateOne(
            { _id: bill._id },
            { $set: { paymentsReceived: incomingPayments } }
          );
        }
      } catch (paySyncErr) {
        console.warn("Could not sync payments on bill patch:", paySyncErr.message);
      }
    }

    // Update corresponding Tally payment in Payment ledger
    try {
      const tallyNote = `Bill Book ${bill.bookNo} - Bill #${bill.billNo} Finalized (Baqaya: Rs ${Number(bill.grandTotalBaqaya || 0).toLocaleString()})`;
      await Payment.findOneAndUpdate(
        {
          userId,
          businessOwnerId: bill.businessOwnerId,
          type: "Tally",
          linkedLot: `Bill #${bill.billNo}`,
        },
        {
          $set: {
            amount: Number(bill.grandTotalBaqaya || 0),
            party: bill.ownerName || "Owner",
            date: bill.date,
            ownerBillId: bill._id,
            billedInBillNo: bill.billNo,
            note: tallyNote,
          },
        }
      );
    } catch (_) {}

    emitOrgChange(req, "owner_bill", { billId: String(bill._id), action: "owner_bill_updated" });
    res.json(normalize(bill));
  } catch (error) {
    res.status(400).json({ message: "Error updating bill", error: error.message });
  }
});

// 5. Delete bill
router.delete("/:id", async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);

    const bill = await OwnerBill.findOneAndDelete({ _id: req.params.id, userId });
    if (!bill) {
      return res.status(404).json({ message: "Bill not found" });
    }

    // Clean up corresponding Tally payment and manual cash payments created for this bill
    try {
      await Payment.deleteMany({
        userId,
        businessOwnerId: bill.businessOwnerId,
        $or: [
          { type: "Tally", linkedLot: `Bill #${bill.billNo}` },
          { ownerBillId: bill._id },
          { billedInBillNo: bill.billNo, party: "Owner" },
        ],
      });
    } catch (_) {}

    // Unlink payments from this bill
    try {
      await Payment.updateMany(
        {
          userId,
          $or: [
            { ownerBillId: bill._id },
            { billedInBillNo: bill.billNo },
          ],
        },
        {
          $set: {
            ownerBillId: null,
            billedInBillNo: null,
          },
        }
      );
    } catch (_) {}

    // Revert lots back to 'received back' (billable)
    try {
      await GhausiaLot.updateMany(
        {
          userId,
          $and: [
            {
              $or: [
                { businessOwnerId: bill.businessOwnerId },
                { businessOwnerId: null },
                { businessOwnerId: { $exists: false } },
              ],
            },
            {
              $or: [
                { ownerBillId: bill._id },
                { billedInBillNo: bill.billNo, billedInBookNo: bill.bookNo },
              ],
            },
          ],
        },
        {
          $set: {
            status: "received back",
            ownerBillId: null,
            billedInBillNo: null,
            billedInBookNo: null,
          },
        }
      );
      emitOrgChange(req, "lot", { action: "lots_unbilled" });
    } catch (revertErr) {
      console.warn("Could not revert lots on bill delete:", revertErr.message);
    }

    emitOrgChange(req, "owner_bill", { billId: String(bill._id), action: "owner_bill_deleted" });
    emitOrgChange(req, "payment", { action: "payment_deleted", linkPath: "/payments" });
    res.json({ message: "Bill deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting bill", error: error.message });
  }
});

module.exports = router;
