require('dotenv').config();
const connectDB = require('./config/db');

connectDB().then(async () => {
  const GhausiaLot = require('./models/GhausiaLot');
  const badLots = await GhausiaLot.find({ $expr: { $eq: ['$_id', '$linkedLotId'] } }).lean();
  console.log('Bad lots:', badLots.map(l => l.lotNumber));
  if (badLots.length > 0) {
    await GhausiaLot.updateMany(
      { $expr: { $eq: ['$_id', '$linkedLotId'] } },
      { $set: { linkedLotId: null, suitType: '2-piece' } }
    );
    console.log('Fixed bad lots');
  }
  process.exit(0);
}).catch(console.error);
