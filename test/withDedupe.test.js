const test = require("node:test");
const assert = require("node:assert/strict");
const { withDedupe } = require("../src/withDedupe");

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test("withDedupe coalesces concurrent calls with the same args into one call", async () => {
  let calls = 0;
  const fn = withDedupe(async (id) => {
    calls++;
    return delay(20, `result-${id}`);
  });

  const [a, b, c] = await Promise.all([fn(1), fn(1), fn(1)]);

  assert.equal(calls, 1);
  assert.equal(a, "result-1");
  assert.equal(b, "result-1");
  assert.equal(c, "result-1");
});

test("withDedupe treats different args as different keys", async () => {
  let calls = 0;
  const fn = withDedupe(async (id) => {
    calls++;
    return delay(10, id);
  });

  await Promise.all([fn(1), fn(2)]);

  assert.equal(calls, 2);
});

test("withDedupe allows a fresh call once the in-flight one settles", async () => {
  let calls = 0;
  const fn = withDedupe(async () => {
    calls++;
    return "ok";
  });

  await fn();
  await fn();

  assert.equal(calls, 2);
});

test("withDedupe clears the in-flight entry even when the call rejects", async () => {
  let calls = 0;
  const fn = withDedupe(async () => {
    calls++;
    throw new Error("boom");
  });

  await assert.rejects(() => fn(), /boom/);
  await assert.rejects(() => fn(), /boom/);

  assert.equal(calls, 2);
});

test("withDedupe shares a rejection across concurrent callers", async () => {
  let calls = 0;
  const fn = withDedupe(async () => {
    calls++;
    await delay(15);
    throw new Error("boom");
  });

  const results = await Promise.allSettled([fn(), fn()]);

  assert.equal(calls, 1);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
});

test("withDedupe supports a custom keyFn", async () => {
  let calls = 0;
  const fn = withDedupe(
    async (req) => {
      calls++;
      return delay(10, req.url);
    },
    { keyFn: (req) => req.url }
  );

  const [a, b] = await Promise.all([
    fn({ url: "/x", nonce: 1 }),
    fn({ url: "/x", nonce: 2 }),
  ]);

  assert.equal(calls, 1);
  assert.equal(a, "/x");
  assert.equal(b, "/x");
});

test("withDedupe does not merge calls that carry different AbortSignals", async () => {
  let calls = 0;
  const fn = withDedupe(async () => {
    calls++;
    return delay(10, "ok");
  });
  const a = new AbortController();
  const b = new AbortController();

  await Promise.all([fn({ signal: a.signal }), fn({ signal: b.signal })]);
  assert.equal(calls, 2);
});

test("withDedupe still merges calls that share the same AbortSignal", async () => {
  let calls = 0;
  const fn = withDedupe(async () => {
    calls++;
    return delay(10, "ok");
  });
  const a = new AbortController();

  await Promise.all([fn({ signal: a.signal, id: 1 }), fn({ id: 1, signal: a.signal })]);
  assert.equal(calls, 1);
});

test("withDedupe ignores plain-object key order", async () => {
  let calls = 0;
  const fn = withDedupe(async () => {
    calls++;
    return delay(10, "ok");
  });

  await Promise.all([fn({ a: 1, b: { x: 1, y: 2 } }), fn({ b: { y: 2, x: 1 }, a: 1 })]);
  assert.equal(calls, 1);
});

test("withDedupe handles bigint and circular args without throwing", async () => {
  let calls = 0;
  const fn = withDedupe(async () => {
    calls++;
    return delay(10, "ok");
  });
  const circular = {};
  circular.self = circular;

  await Promise.all([fn(1n), fn(1n), fn(circular), fn(circular)]);
  assert.equal(calls, 2);
});
