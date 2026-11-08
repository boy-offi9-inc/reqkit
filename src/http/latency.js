/**
 * Remembers recent response times per key (an origin) so `createFetch` can
 * hedge at "my usual slow" instead of a hand-tuned constant.
 */
function createLatencyTracker({ maxSamples = 100, maxKeys = 200 } = {}) {
  const byKey = new Map();

  return {
    record(key, ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      let samples = byKey.get(key);
      if (!samples) {
        samples = [];
        byKey.set(key, samples);
        if (byKey.size > maxKeys) byKey.delete(byKey.keys().next().value); // forget the oldest origin
      }
      samples.push(ms);
      if (samples.length > maxSamples) samples.shift();
    },

    count(key) {
      const samples = byKey.get(key);
      return samples ? samples.length : 0;
    },

    /** The p-th percentile (0–1) of the recent samples for `key`, or null when there are none. */
    percentile(key, p) {
      const samples = byKey.get(key);
      if (!samples || samples.length === 0) return null;
      const sorted = [...samples].sort((a, b) => a - b);
      const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
      return sorted[index];
    },

    clear() {
      byKey.clear();
    },
  };
}

module.exports = { createLatencyTracker };
