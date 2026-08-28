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
