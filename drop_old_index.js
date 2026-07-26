const mongoose = require('mongoose');
const GhausiaLot = require('./models/GhausiaLot');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB.");
  
  try {
    await GhausiaLot.collection.dropIndex("userId_1_businessOwnerId_1_lotNumber_1_partial_unique");
    console.log("Old index dropped successfully.");
  } catch (e) {
    if (e.codeName === 'IndexNotFound') {
      console.log("Old index does not exist (already dropped).");
    } else {
      console.error("Error dropping old index:", e);
    }
  }

  try {
    await GhausiaLot.collection.dropIndex("userId_1_businessOwnerId_1_lotNumber_1_unique");
    console.log("Older index dropped successfully.");
  } catch (e) {
  }
  
  await mongoose.disconnect();
}
run();
