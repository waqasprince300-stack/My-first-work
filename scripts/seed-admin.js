require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const run = async () => {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD, MONGODB_URI } = process.env;

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('ADMIN_NAME, ADMIN_EMAIL, and ADMIN_PASSWORD are required');
  }

  await mongoose.connect(MONGODB_URI);

  await User.updateMany(
    { role: 'super_admin' },
    { $set: { role: 'admin' } },
  );

  const email = ADMIN_EMAIL.trim().toLowerCase();
  let user = await User.findOne({ email }).select('+password');

  if (!user) {
    user = await User.create({
      name: ADMIN_NAME.trim(),
      email,
      password: ADMIN_PASSWORD,
      role: 'admin',
      status: 'approved',
    });
  }

  user.role = 'admin';
  user.status = 'approved';
  user.ownerId = user._id;
  user.approvedBy = user._id;
  user.approvedAt = user.approvedAt || new Date();
  user.rejectedAt = null;
  user.disabledAt = null;
  await user.save({ validateBeforeSave: false });

  await User.updateMany(
    { _id: { $ne: user._id }, status: { $exists: false } },
    { $set: { role: 'party', status: 'pending' } },
  );

  console.log(`Organization admin ready: ${user.email}`);
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect();
  process.exit(1);
});
