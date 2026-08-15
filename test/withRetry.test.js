const test = require("node:test");
const assert = require("node:assert/strict");
const { withRetry } = require("../src/withRetry");

test("withRetry resolves immediately if fn succeeds first try", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry retries the configured number of times then throws", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error("always fails");
        },
        { retries: 2, baseDelayMs: 1 }
      ),
    /always fails/
  );
  assert.equal(calls, 3); // initial try + 2 retries
});

test("withRetry succeeds after a few failures", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("not yet");
      return "eventually ok";
    },
    { retries: 5, baseDelayMs: 1 }
  );
  assert.equal(result, "eventually ok");
  assert.equal(calls, 3);
});

test("withRetry stops immediately when shouldRetry returns false", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error("non-retryable");
        },
        { retries: 5, baseDelayMs: 1, shouldRetry: () => false }
      )
  );
  assert.equal(calls, 1);
});

test("withRetry calls onRetry with attempt info", async () => {
  const retryLog = [];
  let calls = 0;
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls++;
        throw new Error("fail");
      },
      {
        retries: 2,
        baseDelayMs: 1,
        onRetry: (err, attempt, delayMs) => retryLog.push({ attempt, delayMs }),
      }
    )
  );
  assert.equal(retryLog.length, 2);
  assert.equal(retryLog[0].attempt, 0);
  assert.equal(retryLog[1].attempt, 1);
});
