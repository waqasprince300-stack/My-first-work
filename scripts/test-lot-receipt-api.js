require('dotenv').config();
const PartyEdit = require('../models/PartyEdit');
const GhausiaLot = require('../models/GhausiaLot');
const connectDB = require('../config/db');

const TEST_LOT_ID = '6a05d583b50302be1ebe41ad';

connectDB()
  .then(async () => {
    const pe = await PartyEdit.findOne({
      lotId: TEST_LOT_ID,
      receipt: { $exists: true, $nin: [null, ''] },
    }).lean();

    if (!pe) {
      console.log('No party edit with receipt for test lot');
      process.exit(1);
    }

    const userId = pe.userId;
    const lotIdStr = TEST_LOT_ID;
    let businessOwnerId = String(pe.businessOwnerId);

    console.log('Simulating admin fetch for', { lotIdStr, userId: String(userId), businessOwnerId });

    let row = await PartyEdit.findOne({ lotId: lotIdStr, userId, businessOwnerId }).lean();
    console.log('Exact match:', Boolean(row), row?.receipt ? `receipt len ${row.receipt.length}` : 'no receipt');

    row = await PartyEdit.findOne({ lotId: lotIdStr, userId }).lean();
    console.log('Fallback match:', Boolean(row), row?.receipt ? `receipt len ${row.receipt.length}` : 'no receipt');

    const lot = await GhausiaLot.findOne({ _id: lotIdStr, userId }).select('businessOwnerId').lean();
    console.log('Lot lookup:', { found: Boolean(lot), biz: lot ? String(lot.businessOwnerId) : null });

    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
