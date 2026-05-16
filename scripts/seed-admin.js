require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { connectMongooseForScripts } = require('../config/mongooseConnect');

const run = async () => {
  const MONGODB_URI = process.env.MONGODB_URI;
  const ADMIN_NAME = process.env.SUPER_ADMIN_NAME || process.env.ADMIN_NAME;
  const ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || process.env.ADMIN_EMAIL;
  const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      'Set SUPER_ADMIN_NAME, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD (or legacy ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD)',
    );
  }

  await connectMongooseForScripts(MONGODB_URI);

  const email = ADMIN_EMAIL.trim().toLowerCase();
  let user = await User.findOne({ email }).select('+password');

  if (!user) {
    user = await User.create({
      name: ADMIN_NAME.trim(),
      email,
      password: ADMIN_PASSWORD,
      role: 'super_admin',
      status: 'approved',
    });
  }

  user.role = 'super_admin';
  user.status = 'approved';
  user.ownerId = user._id;
  user.approvedBy = user._id;
  user.approvedAt = user.approvedAt || new Date();
  user.rejectedAt = null;
  user.disabledAt = null;
  await user.save({ validateBeforeSave: false });

  console.log(`Platform super administrator ready: ${user.email}`);
  console.log('Tip: use a dedicated super-admin email (not your day-to-day org admin), so that user can approve new administrators without losing business-admin API access.');
  console.log('Organization admins who sign up while a super admin exists will stay pending until approved in the app.');
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect();
  process.exit(1);
});
