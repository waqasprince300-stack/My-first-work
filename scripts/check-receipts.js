require("dotenv").config();
const PartyEdit = require("../models/PartyEdit");
const GhausiaLot = require("../models/GhausiaLot");
const connectDB = require("../config/db");

connectDB()
  .then(async () => {
    const withReceipt = await PartyEdit.find({
      receipt: { $exists: true, $nin: [null, ""] },
    })
      .select("lotId userId businessOwnerId")
      .limit(8)
      .lean();

    console.log("Sample partyEdits WITH receipt:", withReceipt.length);
    for (const r of withReceipt) {
      const _lot = await GhausiaLot.findById(r.lotId)
        .select("_id lotNumber")
        .lean()
        .catch(() => null);
      const lotByStr = await GhausiaLot.findOne({ _id: r.lotId })
        .select("_id lotNumber")
        .lean();
      console.log({
        partyEditLotId: r.lotId,
        lotFoundById: Boolean(lotByStr),
        lotNumber: lotByStr?.lotNumber,
        receiptWouldNeedIncludeReceipts: true,
      });
    }

    const total = await PartyEdit.countDocuments();
    const withR = await PartyEdit.countDocuments({
      receipt: { $exists: true, $nin: [null, ""] },
    });
    console.log("Total partyEdits:", total, "| with receipt:", withR);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
