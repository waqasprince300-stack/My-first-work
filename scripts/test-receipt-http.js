require("dotenv").config();
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const PartyEdit = require("../models/PartyEdit");
const BusinessOwner = require("../models/BusinessOwner");
const connectDB = require("../config/db");

const API = process.env.TEST_API_BASE || "http://localhost:3001/api";

const getJwtSecret = () =>
  process.env.JWT_SECRET || "development-jwt-secret-change-me";

connectDB()
  .then(async () => {
    const admins = await User.find({ role: "admin", status: "approved" })
      .limit(5)
      .lean();
    console.log(
      "Admins:",
      admins.map((u) => String(u._id)),
    );

    for (const user of admins) {
      const pe = await PartyEdit.findOne({
        userId: user._id,
        receipt: { $exists: true, $nin: [null, ""] },
      }).lean();
      if (!pe) continue;

      const owner = await BusinessOwner.findOne({
        _id: pe.businessOwnerId,
        userId: user._id,
        status: "active",
      }).lean();

      const token = jwt.sign({ id: user._id }, getJwtSecret(), {
        expiresIn: "1h",
      });
      const lotId = pe.lotId;
      const biz = String(pe.businessOwnerId);

      console.log(
        "\nTesting user",
        user.email,
        "lot",
        lotId,
        "biz",
        biz,
        "ownerActive",
        Boolean(owner),
      );

      const url = `${API}/partyEdits/lot/${lotId}?includeReceipts=1&businessOwnerId=${biz}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-business-owner-id": biz,
        },
      });
      const body = await res.json();
      console.log(
        "LOCAL",
        res.status,
        "receiptLen",
        body?.receipt?.length || 0,
        body?.message || "",
      );

      const prodUrl = `https://backend.seamandgrace.com/api/partyEdits/lot/${lotId}?includeReceipts=1&businessOwnerId=${biz}`;
      const res2 = await fetch(prodUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-business-owner-id": biz,
        },
      });
      const body2 = await res2.json();
      console.log(
        "PROD",
        res2.status,
        "receiptLen",
        body2?.receipt?.length || 0,
        body2?.message || "",
      );
      break;
    }

    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
