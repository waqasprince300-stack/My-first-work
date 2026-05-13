const dns = require('dns');
const mongoose = require('mongoose');

// MONGODB_URI from .env; optional MONGODB_DB_NAME when the URI omits `/dbname`.
// If mongodb+srv fails with querySrv ECONNREFUSED, set NODE_DNS_SERVERS=8.8.8.8,1.1.1.1 (Windows DNS often blocks SRV).
const connectDB = async () => {
  const dnsServers = process.env.NODE_DNS_SERVERS?.trim();
  if (dnsServers) {
    dns.setServers(dnsServers.split(',').map((s) => s.trim()).filter(Boolean));
  }

  const mongoUri = process.env.MONGODB_URI?.trim();

  if (!mongoUri) {
    console.error(
      '❌ MONGODB_URI is missing. Set it in .env (e.g. MONGODB_URI=mongodb+srv://... or mongodb://127.0.0.1:27017/dbname)'
    );
    process.exit(1);
  }

  try {
    const opts = {};
    const dbName = process.env.MONGODB_DB_NAME?.trim();
    if (dbName) {
      opts.dbName = dbName;
    }

    await mongoose.connect(mongoUri, opts);

    console.log('✅ MongoDB connected:', mongoose.connection.host);
    console.log(`   Database: ${mongoose.connection.name}`);

    mongoose.connection.on('disconnected', () => {
      console.log('⚠️ MongoDB disconnected');
    });

    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err);
    });

    return mongoose.connection;
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    if (/querySrv|ECONNREFUSED/i.test(String(error.message))) {
      console.error(
        '   Hint: SRV lookup failed. Try NODE_DNS_SERVERS=8.8.8.8,1.1.1.1 in .env, or fix Windows DNS / use Atlas “standard connection string” (mongodb://…).'
      );
    }
    process.exit(1);
  }
};

module.exports = connectDB;