(async () => {
  try {
    const connectDB = require("../config/db");
    const User = require("../models/User");
    await connectDB();
    const adminEmail = "seamandgrace+localadmin@gmail.com";
    const existing = await User.findOne({ email: adminEmail });
    if (existing) {
      console.log(
        "User already exists:",
        existing.email,
        existing._id.toString(),
      );
      process.exit(0);
    }
    const user = new User({
      name: "Local Admin",
      email: adminEmail,
      password: "Password123!",
      role: "admin",
      status: "approved",
    });
    user.ownerId = user._id;
    user.approvedBy = user._id;
    user.approvedAt = new Date();
    await user.save();
    console.log("Created approved admin:", user.email, user._id.toString());
    process.exit(0);
  } catch (err) {
    console.error("Error creating admin:", err);
    process.exit(1);
  }
})();
