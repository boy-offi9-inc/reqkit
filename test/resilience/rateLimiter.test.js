const test = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimiter } = require("../../src/resilience/rateLimiter");

const hdrs = (obj) => ({ get: (k) => obj[k.toLowerCase()] ?? null });

test("createRateLimiter lets `requests` through immediately then spaces the rest by the window", async () => {
  const rl = createRateLimiter({ requests: 2, perMs: 80 });
  const t0 = Date.now();
  await rl.acquire();
  await rl.acquire();
  assert.ok(Date.now() - t0 < 40, "first two are immediate");
  await rl.acquire(); // must wait for the window to slide
  assert.ok(Date.now() - t0 >= 70, `third waited (${Date.now() - t0}ms)`);
});

test("createRateLimiter serves callers FIFO", async () => {
  const rl = createRateLimiter({ requests: 1, perMs: 20 });
  const order = [];
  await Promise.all([1, 2, 3, 4].map((n) => rl.acquire().then(() => order.push(n))));
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test("createRateLimiter pauses when the server says remaining is 0 (delta-seconds reset)", async () => {
  const rl = createRateLimiter();
  rl.update({ status: 200, headers: hdrs({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" }) });
  assert.ok(rl.blockedForMs > 800 && rl.blockedForMs <= 1000, `blocked ${rl.blockedForMs}`);
  rl.reset();
  assert.equal(rl.blockedForMs, 0);
});

test("createRateLimiter understands epoch-seconds reset and RateLimit-* headers", () => {
  const rl = createRateLimiter();
  const epoch = Math.floor(Date.now() / 1000) + 2;
  rl.update({ status: 200, headers: hdrs({ "ratelimit-remaining": "0", "ratelimit-reset": String(epoch) }) });
  assert.ok(rl.blockedForMs > 500 && rl.blockedForMs <= 2000, `blocked ${rl.blockedForMs}`);
});

test("createRateLimiter ignores headers while quota remains", () => {
  const rl = createRateLimiter();
  rl.update({ status: 200, headers: hdrs({ "x-ratelimit-remaining": "5", "x-ratelimit-reset": "30" }) });
  assert.equal(rl.blockedForMs, 0);
});

test("createRateLimiter blocks on Retry-After for 429/503 only", () => {
  const rl = createRateLimiter();
  rl.update({ status: 200, headers: hdrs({ "retry-after": "5" }) });
  assert.equal(rl.blockedForMs, 0);
  rl.update({ status: 429, headers: hdrs({ "retry-after": "5" }) });
  assert.ok(rl.blockedForMs > 4000);
});

test("createRateLimiter.acquire waits out a server-imposed pause", async () => {
  const rl = createRateLimiter();
  rl.update({ status: 429, headers: hdrs({ "retry-after": "0.1" }) });
  const t0 = Date.now();
  await rl.acquire();
  assert.ok(Date.now() - t0 >= 80);
});

test("createRateLimiter.acquire rejects with the signal's reason when aborted while waiting", async () => {
  const rl = createRateLimiter();
  rl.update({ status: 429, headers: hdrs({ "retry-after": "30" }) });
  const controller = new AbortController();
  const p = rl.acquire({ signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(p, (e) => e.name === "AbortError");
});

test("an aborted waiter does not consume a slot or block the queue", async () => {
  const rl = createRateLimiter({ requests: 1, perMs: 60 });
  await rl.acquire();
  const controller = new AbortController();
  const aborted = rl.acquire({ signal: controller.signal });
  const next = rl.acquire();
  controller.abort();
  await assert.rejects(aborted, (e) => e.name === "AbortError");
  await next; // still gets served
});

test("createRateLimiter.run acquires, calls, and learns from the result", async () => {
  const rl = createRateLimiter();
  const res = await rl.run(async () => ({ status: 429, headers: hdrs({ "retry-after": "10" }) }));
  assert.equal(res.status, 429);
  assert.ok(rl.blockedForMs > 9000);
});

test("createRateLimiter validates options", () => {
  assert.throws(() => createRateLimiter({ requests: 0 }), TypeError);
  assert.throws(() => createRateLimiter({ perMs: 0 }), TypeError);
  assert.throws(() => createRateLimiter({ perMs: Infinity }), TypeError);
});
