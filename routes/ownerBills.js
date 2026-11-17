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
const { toDateOrNull, toDateOrNow } = require("../utils/dateHelpers");

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

    // Collect all payment IDs that have already been settled in existing finalized bills
    const billedPaymentIds = new Set();
    bills.forEach((b) => {
      (b.paymentsReceived || []).forEach((p) => {
        const pid = String(p.paymentId || p._id || p.id || "").trim();
        if (pid && pid.length === 24) billedPaymentIds.add(pid);
      });
    });
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
        emitOrgChange(req, "lot", { action: "lots_billed" });
      }
    } catch (lotErr) {
      console.warn("Could not mark lots as completed on bill save:", lotErr);
    }

    // 2. Link included payments to this bill so they aren't double-deducted
    try {
      const payIds = (saved.paymentsReceived || [])
        .map((p) => p.paymentId || p.id || p._id)
        .filter((id) => id && String(id).length === 24);
      if (payIds.length > 0) {
        const objectPayIds = payIds.map((id) => {
          try {
            return new mongoose.Types.ObjectId(id);
          } catch (_) {
            return id;
          }
        });
        await Payment.updateMany(
          { _id: { $in: objectPayIds }, userId },
          {
            $set: {
              ownerBillId: saved._id,
              billedInBillNo: saved.billNo,
            },
          }
        );
      }
    } catch (payErr) {
      console.warn("Could not link payments on bill save:", payErr.message);
    }

    // 3. Create a Tally marker payment so the ledger timeline reflects this finalized bill
    try {
      const tallyNote = `Bill Book ${saved.bookNo} - Bill #${saved.billNo} Finalized (Baqaya: Rs ${Number(saved.grandTotalBaqaya || 0).toLocaleString()})`;
      await Payment.create({
        userId,
        businessOwnerId: bizId,
        type: "Tally",
        amount: 0,
        party: saved.ownerName || "Owner",
        date: saved.date,
        note: tallyNote,
        linkedLot: `Bill #${saved.billNo}`,
      });
      emitOrgChange(req, "payment", { action: "payment_recorded", linkPath: "/payments" });
    } catch (tallyErr) {
      console.warn("Could not create tally payment for bill:", tallyErr.message);
    }

    emitOrgChange(req, "owner_bill", { billId: String(saved._id), action: "owner_bill_created" });
    res.status(201).json(normalize(saved));
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

        // Revert any lot previously linked to this bill that was removed in edit
        await GhausiaLot.updateMany(
          {
            userId,
            $or: [
              { ownerBillId: bill._id },
              { billedInBillNo: bill.billNo, billedInBookNo: bill.bookNo },
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
            { userId, $or: markConditions },
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
        }
        emitOrgChange(req, "lot", { action: "lots_billed" });
      } catch (patchLotErr) {
        console.warn("Could not sync lots on bill patch:", patchLotErr.message);
      }
    }

    // Sync payments if updated
    if (req.body.paymentsReceived && Array.isArray(req.body.paymentsReceived)) {
      try {
        const activePayIds = req.body.paymentsReceived
          .map((p) => p.paymentId || p.id || p._id)
          .filter((id) => id && String(id).length === 24)
          .map((id) => {
            try {
              return new mongoose.Types.ObjectId(id);
            } catch (_) {
              return id;
            }
          });

        // Unlink removed payments
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
            party: bill.ownerName || "Owner",
            date: bill.date,
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

    // Clean up corresponding Tally payment if any
    try {
      await Payment.deleteMany({
        userId,
        businessOwnerId: bill.businessOwnerId,
        type: "Tally",
        linkedLot: `Bill #${bill.billNo}`,
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
          $or: [
            { ownerBillId: bill._id },
            { billedInBillNo: bill.billNo, billedInBookNo: bill.bookNo },
            { billedInBillNo: bill.billNo },
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
