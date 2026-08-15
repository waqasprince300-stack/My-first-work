const mongoose = require('mongoose');
require('dotenv').config();
const connectDB = require('./config/db');
const User = require('./models/User');
const Party = require('./models/Party');

async function run() {
  await connectDB();
  
  const rightUser = await User.findOne({ email: 'sammarsaeed07@gmail.com' });
  const party = await Party.findOne({ name: 'Samar Bhai' });
  
  if (rightUser && party) {
    rightUser.role = "party";
    rightUser.status = "approved";
    rightUser.ownerId = party.userId; // admin's ID
    rightUser.partyId = String(party._id);
    rightUser.partyName = party.name;
    rightUser.businessOwnerId = String(party.businessOwnerId);
    rightUser.pendingForAdminId = null;
    rightUser.approvedBy = party.userId;
    rightUser.approvedAt = new Date();
    rightUser.rejectedAt = null;
    rightUser.disabledAt = null;
    
    await rightUser.save({ validateBeforeSave: false });
    console.log("User approved and linked successfully!");
  } else {
    console.log("User or Party not found");
  }

  process.exit(0);
}
run().catch(console.error);
