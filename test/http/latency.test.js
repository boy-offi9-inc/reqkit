const test = require("node:test");
const assert = require("node:assert/strict");
const { createLatencyTracker } = require("../../src/http/latency");

test("percentile of recent samples, per key", () => {
  const t = createLatencyTracker();
  for (let i = 1; i <= 100; i++) t.record("a", i);
  assert.equal(t.count("a"), 100);
  assert.equal(t.percentile("a", 0.5), 50);
  assert.equal(t.percentile("a", 0.95), 95);
  assert.equal(t.percentile("a", 1), 100);
  assert.equal(t.percentile("nothing", 0.95), null);
  assert.equal(t.count("nothing"), 0);
});

test("keeps only the most recent samples", () => {
  const t = createLatencyTracker({ maxSamples: 5 });
  for (let i = 1; i <= 20; i++) t.record("a", i);
  assert.equal(t.count("a"), 5);
  assert.equal(t.percentile("a", 0), 16, "the smallest of the last five");
});

test("ignores junk values and forgets the oldest key past maxKeys", () => {
  const t = createLatencyTracker({ maxKeys: 2 });
  t.record("a", NaN);
  t.record("a", -5);
  assert.equal(t.count("a"), 0);
  t.record("a", 1);
  t.record("b", 1);
  t.record("c", 1);
  assert.equal(t.count("a"), 0, "oldest origin evicted");
  assert.equal(t.count("c"), 1);
  t.clear();
  assert.equal(t.count("c"), 0);
});
