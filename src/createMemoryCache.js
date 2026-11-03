/**
 * A small in-memory LRU store for createFetch's `cache` option. Anything with
 * async-or-sync `get(key)`, `set(key, value)` and `delete(key)` can be used
 * instead (Redis, IndexedDB, a Map...).
 *
 * @param {{ maxEntries?: number }} [opts]
 */
function createMemoryCache(opts = {}) {
  const { maxEntries = 100 } = opts;
  if (!(Number.isInteger(maxEntries) && maxEntries >= 1)) {
    throw new TypeError("createMemoryCache: `maxEntries` must be an integer >= 1");
  }
  const map = new Map();

  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key); // re-insert so it counts as most recently used
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

module.exports = { createMemoryCache };
