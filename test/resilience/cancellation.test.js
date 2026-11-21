// Conformance-style tests for the cancellation/deadline semantics that the
// public HTTP-resilience matrix (fetch-kit/http-resilience) scores. These pin
// the two bug classes that fail most libraries in that suite:
//  - a caller abort (or deadline) landing while a policy is waiting must
//    settle the caller promptly and must never dispatch afterwards
//  - a success admitted before a breaker reopened must not affect the new
//    cooldown (generation hygiene)
const test = require("node:test");
const assert = require("node:assert/strict");
const { withRetry, DeadlineError } = require("../../src/resilience/retry");
const { createCircuitBreaker } = require("../../src/resilience/circuitBreaker");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("withRetry: caller abort during backoff settles promptly and dispatches nothing more", async () => {
  const controller = new AbortController();
  let dispatches = 0;
  const loop = withRetry(
    async () => {
      dispatches++;
      return { status: 503, headers: new Headers() };
    },
    { retries: 10, baseDelayMs: 500, retryStatusCodes: [503], signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 50); // lands mid-backoff
  const t0 = Date.now();
  await assert.rejects(loop, (err) => err.name === "AbortError" || err.name === "RetryAbortedError");
  const settledIn = Date.now() - t0;
  const atAbort = dispatches;
  await sleep(400); // plenty of time for a rogue retry if the loop kept going
  assert.equal(dispatches, atAbort, "no dispatch after the caller aborted");
  assert.ok(settledIn < 300, `caller settled promptly after abort (${settledIn}ms)`);
});

test("withRetry: totalDeadlineMs bounds the caller promise even when fn never observes the signal", async () => {
  let attempts = 0;
  const t0 = Date.now();
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts++;
          await sleep(1000); // hangs past the deadline and ignores everything
          return { status: 200 };
        },
        { retries: 5, baseDelayMs: 10, totalDeadlineMs: 120 }
      ),
    (err) => err instanceof DeadlineError
  );
  const elapsed = Date.now() - t0;
  assert.equal(attempts, 1, "a second attempt must never dispatch");
  assert.ok(elapsed >= 110 && elapsed < 400, `caller settled at the deadline (${elapsed}ms)`);
});

test("withRetry: totalDeadlineMs stops dispatches mid-backoff and surfaces DeadlineError", async () => {
  const dispatchTimes = [];
  const t0 = Date.now();
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          dispatchTimes.push(Date.now() - t0);
          return { status: 503, headers: new Headers() };
        },
        { retries: 10, baseDelayMs: 30, totalDeadlineMs: 150, retryStatusCodes: [503] }
      ),
    (err) => err instanceof DeadlineError
  );
  assert.ok(dispatchTimes.length >= 2, "several attempts ran before the deadline");
  assert.ok(
    dispatchTimes.every((t) => t < 150),
    `no dispatch at or past the deadline: [${dispatchTimes.join(", ")}]`
  );
});

test("withRetry: no deadline set behaves exactly as before (RetryAbortedError contract)", async () => {
  const controller = new AbortController();
  const loop = withRetry(
    async () => {
      return { status: 503, headers: new Headers() };
    },
    { retries: 10, baseDelayMs: 400, retryStatusCodes: [503], signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(loop, (err) => err.name === "RetryAbortedError" || err.name === "AbortError");
});

test("circuit breaker: a late success admitted before the reopen must not close the newer open state", async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 });
  // Request A: admitted while closed, resolves 200 after the breaker has
  // opened, half-opened, probe-failed and re-opened.
  const slowSuccess = breaker.run(async () => {
    await sleep(150);
    return { status: 200 };
  });
  // Request B: fails fast and opens the circuit (generation 1). A 503 result
  // resolves normally — defaultIsFailure just counts it.
  await breaker.run(async () => ({ status: 503 }));
  assert.equal(breaker.state, "open");
  await sleep(110); // past the reset deadline -> half-open
  assert.equal(breaker.state, "half-open");
  // Probe fails -> circuit re-opens (generation 2).
  await breaker.run(async () => ({ status: 503 }));
  assert.equal(breaker.state, "open");
  // A's stale success lands now: it was admitted in the old generation.
  const res = await slowSuccess.catch(() => null);
  assert.equal(res && res.status, 200);
  assert.equal(breaker.state, "open", "stale success must NOT close the newer open state");
  // Admission is still refused during the new cooldown.
  await assert.rejects(() => breaker.run(async () => ({ status: 200 })), (err) => err.name === "CircuitOpenError");
  // After the NEW cooldown the breaker recovers normally.
  await sleep(110);
  const ok = await breaker.run(async () => ({ status: 200 }));
  assert.equal(ok.status, 200);
  assert.equal(breaker.state, "closed");
});
