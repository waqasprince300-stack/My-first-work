const mongoose = require("mongoose");
require("dotenv").config();

async function checkOwners() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      dbName: process.env.MONGODB_DB_NAME,
    });
    console.log("Connected to MongoDB.");
    const db = mongoose.connection.db;
    const owners = await db.collection("businessowners").find({}).toArray();
    console.log(`Found ${owners.length} owners.`);
    console.log(JSON.stringify(owners, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

checkOwners();
