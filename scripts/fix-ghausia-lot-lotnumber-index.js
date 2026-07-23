/**
 * Drops the legacy UNIQUE index on `lotNumber` alone.
 * That index incorrectly blocks reusing the same lot number across business collections.
 *
 * Then creates a partial unique compound index:
 * (userId, businessOwnerId, lotNumber) for non-empty lotNumber.
 *
 * Run: npm run migrate:lot-indexes
 *
 * Requires MONGODB_URI in .env (same as server).
 */

require("dotenv").config();
const mongoose = require("mongoose");

const COLLECTION = "ghausialots";

const COMPOUND_NAME = "userId_1_businessOwnerId_1_lotNumber_1_partial_unique";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("Missing MONGODB_URI in environment");
    process.exit(1);
  }

  await mongoose.connect(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("Connected to MongoDB");

  const col = mongoose.connection.collection(COLLECTION);
  const indexes = await col.indexes();

  const legacy = indexes.find((ix) => ix.name === "lotNumber_1");
  if (legacy) {
    await col.dropIndex("lotNumber_1");
    console.log("Dropped legacy index: lotNumber_1");
  } else {
    console.log("No index lotNumber_1 (skipped drop)");
  }

  try {
    await col.createIndex(
      { userId: 1, businessOwnerId: 1, lotNumber: 1 },
      {
        unique: true,
        name: COMPOUND_NAME,
        partialFilterExpression: {
          lotNumber: { $exists: true, $type: "string", $gt: "" },
        },
      },
    );
    console.log(`Ensured compound unique index: ${COMPOUND_NAME}`);
  } catch (e) {
    if (e.code === 85 || String(e.message || "").includes("already exists")) {
      console.log(`Index ${COMPOUND_NAME} already exists or equivalent OK`);
    } else if (e.code === 11000) {
      console.error(
        "Cannot build unique compound index — duplicate lot numbers exist within the same business collection.",
        "Fix duplicates in MongoDB, then rerun this script.",
      );
      process.exitCode = 1;
    } else {
      console.error(e);
      process.exitCode = 1;
    }
  }

  await mongoose.disconnect();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
