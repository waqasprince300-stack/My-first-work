const mongoose = require('mongoose');
require('dotenv').config();

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;

async function run() {
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 8000 });
  const Payment = mongoose.connection.collection('payments');
  const ghausiaId = new mongoose.Types.ObjectId('6a08bea703c0c6793ff5ff07');

  const res = await Payment.updateMany(
    {
      businessOwnerId: ghausiaId,
      type: 'Received',
    },
    {
      $set: {
        isLegacySettled: true,
        billedInBillNo: 'legacy_settled',
      },
    }
  );

  console.log('Modified count:', res.modifiedCount);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
