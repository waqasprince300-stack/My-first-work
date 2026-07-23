/**
 * One-time: set an existing user's role to super_admin (approved).
 * Usage: PROMOTE_SUPER_ADMIN_EMAIL=user@domain.com MONGODB_URI=... node scripts/promote-super-admin.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const { connectMongooseForScripts } = require("../config/mongooseConnect");

const run = async () => {
  const { MONGODB_URI, PROMOTE_SUPER_ADMIN_EMAIL } = process.env;
  const email = String(PROMOTE_SUPER_ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();

  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }
  if (!email) {
    throw new Error("PROMOTE_SUPER_ADMIN_EMAIL is required");
  }

  await connectMongooseForScripts(MONGODB_URI);
  const user = await User.findOne({ email });

  if (!user) {
    console.error(`No user with email: ${email}`);
    process.exitCode = 1;
    return;
  }

  user.role = "super_admin";
  user.status = "approved";
  user.approvedAt = user.approvedAt || new Date();
  user.rejectedAt = null;
  user.disabledAt = null;
  await user.save({ validateBeforeSave: false });

  console.log(`Updated ${email} → super_admin (approved)`);
  await mongoose.disconnect();
};

run().catch(async (e) => {
  console.error(e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
