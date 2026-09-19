const DEFAULT_TTL_MS = 60_000;

const caches = new Map();
const cacheVersions = new Map();

const getCache = (name) => {
  if (!caches.has(name)) {
    caches.set(name, new Map());
    cacheVersions.set(name, 1);
  }
  return caches.get(name);
};

const getCacheVersion = (name) => {
  if (!cacheVersions.has(name)) return 1;
  return cacheVersions.get(name);
};

const getCached = (name, key) => {
  const store = getCache(name);
  const entry = store.get(String(key));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(String(key));
    return null;
  }
  return entry.value;
};

const setCached = (name, key, value, ttlMs = DEFAULT_TTL_MS, expectedVersion = null) => {
  if (expectedVersion !== null && expectedVersion !== getCacheVersion(name)) {
    return; // Cache was cleared during the fetch, do not poison it with stale data
  }
  const store = getCache(name);
  store.set(String(key), {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

const invalidateCached = (name, key) => {
  getCache(name).delete(String(key));
};

const clearCache = (name) => {
  if (caches.has(name)) {
    caches.get(name).clear();
    const currentVersion = cacheVersions.get(name) || 1;
    cacheVersions.set(name, currentVersion + 1);
  }
};

// Sweep expired entries every 5 minutes to prevent unbounded memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [, store] of caches) {
    for (const [key, entry] of store) {
      if (now > entry.expiresAt) store.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  getCached,
  setCached,
  invalidateCached,
  clearCache,
  getCacheVersion,
};
