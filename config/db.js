const dns = require('dns');
const mongoose = require('mongoose');
const { resolveMongoSrvViaDoh } = require('./resolveMongoSrvViaDoh');
const { getMongooseConnectOptions } = require('./mongooseConnect');

// Prefer IPv4 for DNS + TCP (helps some routers / IPv6 tunnels with Atlas).
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const dnsFailure = (msg) => /queryTxt|querySrv|ETIMEOUT|ECONNREFUSED|ENOTFOUND/i.test(String(msg || ''));

const connectOpts = () =>
  getMongooseConnectOptions({
    serverSelectionTimeoutMS: 45_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: 20,
    minPoolSize: 2,
  });

const wireEvents = () => {
  mongoose.connection.on('disconnected', () => {
    console.log('⚠️ MongoDB disconnected');
  });
  mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB connection error:', err);
  });
};

/**
 * MONGODB_URI — primary.
 * If mongodb+srv fails due to local DNS: tries MONGODB_FALLBACK_URI, then DNS-over-HTTPS (disable with MONGODB_DISABLE_DOH=1).
 */
const connectDB = async () => {
  const dnsServers = process.env.NODE_DNS_SERVERS?.trim();
  if (dnsServers) {
    dns.setServers(dnsServers.split(',').map((s) => s.trim()).filter(Boolean));
  }

  const primaryUri = process.env.MONGODB_URI?.trim();
  const fallbackUri = process.env.MONGODB_FALLBACK_URI?.trim();

  if (!primaryUri) {
    console.error(
      '❌ MONGODB_URI is missing. Set it in .env (e.g. MONGODB_URI=mongodb+srv://... or mongodb://127.0.0.1:27017/dbname)',
    );
    process.exit(1);
  }

  const opts = connectOpts();

  const tryUri = async (uri, label) => {
    await mongoose.connect(uri, opts);
    console.log(`✅ MongoDB connected (${label}):`, mongoose.connection.host);
    console.log(`   Database: ${mongoose.connection.name}`);
  };

  const primaryIsSrv = primaryUri.startsWith('mongodb+srv');

  try {
    await tryUri(primaryUri, 'primary');
    wireEvents();
    return mongoose.connection;
  } catch (error) {
    let msg = String(error.message || error);

    if (primaryIsSrv && fallbackUri && dnsFailure(msg)) {
      console.warn('');
      console.warn('⚠️  SRV/TXT DNS failed for MONGODB_URI — retrying with MONGODB_FALLBACK_URI...');
      console.warn('');
      try {
        await tryUri(fallbackUri, 'fallback');
        wireEvents();
        console.warn('   Tip: you can set that URI as MONGODB_URI to skip the failed srv step.');
        return mongoose.connection;
      } catch (err2) {
        msg = String(err2.message || err2);
        console.error('❌ MONGODB_FALLBACK_URI failed:', msg);
      }
    }

    if (
      primaryIsSrv
      && dnsFailure(msg)
      && process.env.MONGODB_DISABLE_DOH !== '1'
    ) {
      console.warn('');
      console.warn('⚠️  Retrying via DNS-over-HTTPS (Cloudflare) — your PC DNS cannot resolve mongodb+srv.');
      console.warn('');
      try {
        const standardUri = await resolveMongoSrvViaDoh(primaryUri);
        await tryUri(standardUri, 'DNS-over-HTTPS');
        wireEvents();
        console.warn(
          '   Tip: comment out NODE_DNS_SERVERS if set. Optional: paste this mongodb:// string as MONGODB_URI to avoid DoH on startup.',
        );
        return mongoose.connection;
      } catch (errDoh) {
        console.error('❌ DNS-over-HTTPS resolution/connection failed:', errDoh.message || errDoh);
      }
    }

    console.error('❌ MongoDB connection failed:', msg);
    if (dnsFailure(msg)) {
      console.error('');
      console.error('   · Fix: Atlas → Connect → Drivers → copy "mongodb://..." (standard) → MONGODB_URI or MONGODB_FALLBACK_URI');
      console.error('   · Or fix network / VPN; Atlas Network Access → allow your IP.');
      console.error('   · Set MONGODB_DISABLE_DOH=1 only if HTTPS DNS is blocked too.');
      console.error('');
    }
    process.exit(1);
  }
};

module.exports = connectDB;
