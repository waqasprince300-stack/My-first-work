const dns = require("dns");
const mongoose = require("mongoose");
const { resolveMongoSrvViaDoh } = require("./resolveMongoSrvViaDoh");
const { getMongooseConnectOptions } = require("./mongooseConnect");

// Prefer IPv4 for DNS + TCP (helps some routers / IPv6 tunnels with Atlas).
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

const dnsFailure = (msg) =>
  /queryTxt|querySrv|ETIMEOUT|ECONNREFUSED|ENOTFOUND/i.test(String(msg || ""));

/** Last URI that successfully connected (DoH / fallback / primary) — used to reconnect. */
let activeUri = null;
let eventsWired = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let lastDisconnectLogAt = 0;

const connectOpts = () =>
  getMongooseConnectOptions({
    serverSelectionTimeoutMS:
      Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 15_000,
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45_000,
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS) || 15_000,
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 10,
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 0,
    waitQueueTimeoutMS:
      Number(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS) || 15_000,
    // Keep monitoring softer on flaky networks so one blip does not thrash the pool.
    heartbeatFrequencyMS: Number(process.env.MONGO_HEARTBEAT_MS) || 20_000,
    retryReads: true,
    retryWrites: true,
  });

const scheduleReconnect = () => {
  if (!activeUri) return;
  if (
    mongoose.connection.readyState === 1 ||
    mongoose.connection.readyState === 2
  )
    return;
  if (reconnectTimer) return;

  const delay = Math.min(30_000, 1_500 * 2 ** Math.min(reconnectAttempt, 4));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (
      mongoose.connection.readyState === 1 ||
      mongoose.connection.readyState === 2
    )
      return;
    try {
      console.log(`🔄 Reconnecting MongoDB (attempt ${reconnectAttempt})…`);
      await mongoose.connect(activeUri, connectOpts());
      reconnectAttempt = 0;
      console.log("✅ MongoDB reconnected:", mongoose.connection.host);
    } catch (err) {
      console.error("❌ MongoDB reconnect failed:", err.message || err);
      scheduleReconnect();
    }
  }, delay);
};

const wireEvents = () => {
  if (eventsWired) return;
  eventsWired = true;

  mongoose.connection.on("connected", () => {
    reconnectAttempt = 0;
  });

  mongoose.connection.on("disconnected", () => {
    const now = Date.now();
    // Avoid spam when several pool sockets close at once.
    if (now - lastDisconnectLogAt > 2_000) {
      lastDisconnectLogAt = now;
      console.log("⚠️ MongoDB disconnected — will auto-reconnect…");
    }
    scheduleReconnect();
  });

  mongoose.connection.on("error", (err) => {
    console.error("❌ MongoDB connection error:", err.message || err);
  });
};

/**
 * MONGODB_URI — primary.
 * If mongodb+srv fails due to local DNS: tries MONGODB_FALLBACK_URI, then DNS-over-HTTPS (disable with MONGODB_DISABLE_DOH=1).
 */
const connectDB = async () => {
  const dnsServers = process.env.NODE_DNS_SERVERS?.trim();
  if (dnsServers) {
    dns.setServers(
      dnsServers
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  const primaryUri = process.env.MONGODB_URI?.trim();
  const fallbackUri = process.env.MONGODB_FALLBACK_URI?.trim();

  if (!primaryUri) {
    console.error(
      "❌ MONGODB_URI is missing. Set it in .env (e.g. MONGODB_URI=mongodb+srv://... or mongodb://127.0.0.1:27017/dbname)",
    );
    process.exit(1);
  }

  const opts = connectOpts();

  const tryUri = async (uri, label) => {
    await mongoose.connect(uri, opts);
    activeUri = uri;
    reconnectAttempt = 0;
    console.log(`✅ MongoDB connected (${label}):`, mongoose.connection.host);
    console.log(`   Database: ${mongoose.connection.name}`);
  };

  const primaryIsSrv = primaryUri.startsWith("mongodb+srv");

  try {
    await tryUri(primaryUri, "primary");
    wireEvents();
    return mongoose.connection;
  } catch (error) {
    let msg = String(error.message || error);

    if (primaryIsSrv && fallbackUri && dnsFailure(msg)) {
      console.warn("");
      console.warn(
        "⚠️  SRV/TXT DNS failed for MONGODB_URI — retrying with MONGODB_FALLBACK_URI...",
      );
      console.warn("");
      try {
        await tryUri(fallbackUri, "fallback");
        wireEvents();
        console.warn(
          "   Tip: you can set that URI as MONGODB_URI to skip the failed srv step.",
        );
        return mongoose.connection;
      } catch (err2) {
        msg = String(err2.message || err2);
        console.error("❌ MONGODB_FALLBACK_URI failed:", msg);
      }
    }

    if (
      primaryIsSrv &&
      dnsFailure(msg) &&
      process.env.MONGODB_DISABLE_DOH !== "1"
    ) {
      console.warn("");
      console.warn(
        "⚠️  Retrying via DNS-over-HTTPS (Cloudflare) — your PC DNS cannot resolve mongodb+srv.",
      );
      console.warn("");
      try {
        const standardUri = await resolveMongoSrvViaDoh(primaryUri);
        await tryUri(standardUri, "DNS-over-HTTPS");
        wireEvents();
        console.warn(
          "   Tip: PC DNS is unreliable for Atlas. In Atlas → Connect → Drivers, copy the standard",
        );
        console.warn(
          "   mongodb://… string into .env as MONGODB_URI (or MONGODB_FALLBACK_URI) for a stable connection.",
        );
        console.warn(
          "   Also Atlas → Network Access → Allow Access from Anywhere (0.0.0.0/0) or your current IP.",
        );
        return mongoose.connection;
      } catch (errDoh) {
        console.error(
          "❌ DNS-over-HTTPS resolution/connection failed:",
          errDoh.message || errDoh,
        );
      }
    }

    console.error("❌ MongoDB connection failed:", msg);
    if (dnsFailure(msg)) {
      console.error("");
      console.error(
        '   · Fix: Atlas → Connect → Drivers → copy "mongodb://..." (standard) → MONGODB_URI or MONGODB_FALLBACK_URI',
      );
      console.error(
        "   · Or fix network / VPN; Atlas Network Access → allow your IP.",
      );
      console.error(
        "   · Set MONGODB_DISABLE_DOH=1 only if HTTPS DNS is blocked too.",
      );
      console.error("");
    }
    process.exit(1);
  }
};

module.exports = connectDB;
