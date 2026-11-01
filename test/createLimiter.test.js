const test = require("node:test");
const assert = require("node:assert/strict");
const { createLimiter } = require("../src/createLimiter");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("createLimiter never runs more than `concurrency` tasks at once", async () => {
  const limit = createLimiter(2);
  let running = 0;
  let peak = 0;
  const task = async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(10);
    running--;
  };
  await Promise.all(Array.from({ length: 6 }, () => limit(task)));
  assert.equal(peak, 2);
});

test("createLimiter reports activeCount and pendingCount", async () => {
  const limit = createLimiter(1);
  const a = limit(() => sleep(20));
  const b = limit(() => sleep(1));
  assert.equal(limit.activeCount, 1);
  assert.equal(limit.pendingCount, 1);
  await Promise.all([a, b]);
  assert.equal(limit.activeCount, 0);
  assert.equal(limit.pendingCount, 0);
});

test("createLimiter passes args through and preserves results and order in map()", async () => {
  const limit = createLimiter(3);
  const out = await limit.map([3, 1, 2], async (n, i) => {
    await sleep(n * 5);
    return `${i}:${n}`;
  });
  assert.deepEqual(out, ["0:3", "1:1", "2:2"]);
  assert.equal(await limit((a, b) => a + b, 1, 2), 3);
});

test("createLimiter keeps going after a task rejects or throws synchronously", async () => {
  const limit = createLimiter(1);
  const bad = limit(() => Promise.reject(new Error("nope")));
  const sync = limit(() => {
    throw new Error("sync");
  });
  const good = limit(async () => "ok");
  await assert.rejects(bad, /nope/);
  await assert.rejects(sync, /sync/);
  assert.equal(await good, "ok");
});

test("createLimiter runs tasks in FIFO order", async () => {
  const limit = createLimiter(1);
  const order = [];
  await Promise.all([1, 2, 3].map((n) => limit(async () => order.push(n))));
  assert.deepEqual(order, [1, 2, 3]);
});

test("createLimiter validates concurrency", () => {
  assert.throws(() => createLimiter(0), TypeError);
  assert.throws(() => createLimiter(1.5), TypeError);
  assert.throws(() => createLimiter(-1), TypeError);
  assert.doesNotThrow(() => createLimiter(Infinity));
});
