const mongoose = require("mongoose");
const { resolveMongoSrvViaDoh } = require("./resolveMongoSrvViaDoh");

/**
 * Shared MongoDB connection options so scripts use the same database as the API
 * when MONGODB_URI omits /dbname (Atlas strings often end with /?options only).
 */
function getMongooseConnectOptions(overrides = {}) {
  const opts = { ...overrides };
  const dbName = process.env.MONGODB_DB_NAME?.trim();
  if (dbName) {
    opts.dbName = dbName;
  }
  return opts;
}

const dnsFailure = (msg) =>
  /queryTxt|querySrv|ETIMEOUT|ECONNREFUSED|ENOTFOUND/i.test(String(msg || ""));

/**
 * Connect for CLI scripts: same dbName as server; optional DoH when mongodb+srv local DNS fails.
 */
async function connectMongooseForScripts(uri, overrides = {}) {
  const opts = getMongooseConnectOptions({
    serverSelectionTimeoutMS: 45_000,
    socketTimeoutMS: 45_000,
    ...overrides,
  });
  try {
    await mongoose.connect(uri, opts);
    return;
  } catch (err) {
    const primaryIsSrv = uri.startsWith("mongodb+srv");
    const fallbackUri = process.env.MONGODB_FALLBACK_URI?.trim();
    if (primaryIsSrv && fallbackUri && dnsFailure(err.message)) {
      await mongoose.connect(fallbackUri, opts);
      return;
    }
    if (
      primaryIsSrv &&
      dnsFailure(err.message) &&
      process.env.MONGODB_DISABLE_DOH !== "1"
    ) {
      const standard = await resolveMongoSrvViaDoh(uri);
      await mongoose.connect(standard, opts);
      return;
    }
    throw err;
  }
}

module.exports = { getMongooseConnectOptions, connectMongooseForScripts };
