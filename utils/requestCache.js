const DEFAULT_TTL_MS = 60_000;

const caches = new Map();

const getCache = (name) => {
  if (!caches.has(name)) {
    caches.set(name, new Map());
  }
  return caches.get(name);
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

const setCached = (name, key, value, ttlMs = DEFAULT_TTL_MS) => {
  const store = getCache(name);
  store.set(String(key), {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

const invalidateCached = (name, key) => {
  getCache(name).delete(String(key));
};

module.exports = {
  getCached,
  setCached,
  invalidateCached,
};
