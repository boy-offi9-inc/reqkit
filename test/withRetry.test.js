const test = require("node:test");
const assert = require("node:assert/strict");
const { withRetry, RetryAbortedError } = require("../src/withRetry");

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

test("withRetry rejects immediately if the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await assert.rejects(
    () =>
      withRetry(async () => {
        calls++;
        return "ok";
      }, { signal: controller.signal }),
    RetryAbortedError
  );
  assert.equal(calls, 0);
});

test("withRetry stops retrying once aborted mid-backoff", async () => {
  const controller = new AbortController();
  let calls = 0;

  const promise = withRetry(
    async () => {
      calls++;
      throw new Error("always fails");
    },
    { retries: 5, baseDelayMs: 50, signal: controller.signal }
  );

  // Let the first attempt fail and enter its backoff wait, then abort.
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(() => promise, RetryAbortedError);
  assert.equal(calls, 1);
});

test("withRetry succeeds normally when a signal is provided but never aborted", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw new Error("fail once");
      return "ok";
    },
    { retries: 3, baseDelayMs: 1, signal: controller.signal }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("RetryAbortedError carries the last failure as `cause`", async () => {
  const { withRetry, RetryAbortedError } = require("../src/withRetry");
  const controller = new AbortController();
  const boom = new Error("boom");
  const promise = withRetry(
    async () => {
      throw boom;
    },
    { retries: 3, baseDelayMs: 50, signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (err) => err instanceof RetryAbortedError && err.cause === boom);
});

// ---- unified retry: results, Retry-After, budgets, StopRetry ----------------

const { StopRetry } = require("../src/withRetry");
const hdrs = (obj) => ({ get: (k) => obj[k.toLowerCase()] ?? null });
const FASTR = { baseDelayMs: 1, maxDelayMs: 2, jitter: 0 };

test("withRetry retries listed status codes on results and returns the final result", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => (++calls < 3 ? { status: 503, headers: hdrs({}) } : { status: 200, headers: hdrs({}) }),
    { ...FASTR, retryStatusCodes: [503] }
  );
  assert.equal(result.status, 200);
  assert.equal(calls, 3);
});

test("withRetry returns the last bad result once retries run out (does not throw)", async () => {
  let calls = 0;
  const result = await withRetry(async () => (calls++, { status: 503, headers: hdrs({}) }), {
    ...FASTR,
    retries: 2,
    retryStatusCodes: [503],
  });
  assert.equal(result.status, 503);
  assert.equal(calls, 3);
});

test("withRetry does not retry statuses by default", async () => {
  let calls = 0;
  const result = await withRetry(async () => (calls++, { status: 503 }), FASTR);
  assert.equal(result.status, 503);
  assert.equal(calls, 1);
});

test("withRetry supports shouldRetryResult predicates", async () => {
  let calls = 0;
  const result = await withRetry(async () => ({ ready: ++calls >= 3 }), {
    ...FASTR,
    shouldRetryResult: (r) => !r.ready,
  });
  assert.equal(result.ready, true);
  assert.equal(calls, 3);
});

test("withRetry waits for Retry-After on retried results (and caps it with maxRetryAfterMs)", async () => {
  const waits = [];
  let calls = 0;
  await withRetry(
    async () => (++calls < 2 ? { status: 429, headers: hdrs({ "retry-after": "120" }) } : { status: 200 }),
    {
      ...FASTR,
      retryStatusCodes: [429],
      maxRetryAfterMs: 5,
      onRetry: (e, attempt, ms, ctx) => waits.push([ms, ctx.reason, ctx.status]),
    }
  );
  assert.deepEqual(waits, [[5, "result", 429]]);
});

test("withRetry can ignore Retry-After with respectRetryAfter:false", async () => {
  const waits = [];
  let calls = 0;
  await withRetry(
    async () => (++calls < 2 ? { status: 429, headers: hdrs({ "retry-after": "120" }) } : { status: 200 }),
    { ...FASTR, retryStatusCodes: [429], respectRetryAfter: false, onRetry: (e, a, ms) => waits.push(ms) }
  );
  assert.deepEqual(waits, [1]);
});

test("withRetry cancels the body of a result it retries", async () => {
  let cancelled = 0;
  let calls = 0;
  await withRetry(
    async () =>
      ++calls < 2 ? { status: 503, bodyUsed: false, body: { cancel: async () => void cancelled++ } } : { status: 200 },
    { ...FASTR, retryStatusCodes: [503] }
  );
  assert.equal(cancelled, 1);
});

test("withRetry stops when the maxRetryTime budget would be exceeded (error)", async () => {
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    withRetry(async () => (calls++, Promise.reject(new Error("down"))), {
      retries: Infinity,
      baseDelayMs: 40,
      maxDelayMs: 40,
      jitter: 0,
      maxRetryTime: 100,
    }),
    /down/
  );
  assert.ok(calls >= 2 && calls <= 4, `calls=${calls}`);
  assert.ok(Date.now() - started < 400);
});

test("withRetry stops when the maxRetryTime budget would be exceeded (result)", async () => {
  const result = await withRetry(async () => ({ status: 503, headers: hdrs({ "retry-after": "10" }) }), {
    retries: 5,
    retryStatusCodes: [503],
    maxRetryTime: 50,
  });
  assert.equal(result.status, 503);
});

test("withRetry honors calculateDelay (custom wait, or false to stop)", async () => {
  const waits = [];
  let calls = 0;
  await withRetry(async () => (++calls < 3 ? Promise.reject(new Error("x")) : "ok"), {
    calculateDelay: ({ attempt }) => attempt + 1,
    onRetry: (e, a, ms) => waits.push(ms),
  });
  assert.deepEqual(waits, [1, 2]);

  let tries = 0;
  await assert.rejects(
    withRetry(async () => (tries++, Promise.reject(new Error("stop"))), { calculateDelay: () => false }),
    /stop/
  );
  assert.equal(tries, 1);
});

test("withRetry jitter:'full' stays within [0, delay] and factor is configurable", async () => {
  const waits = [];
  let calls = 0;
  await withRetry(async () => (++calls < 4 ? Promise.reject(new Error("x")) : "ok"), {
    baseDelayMs: 4,
    maxDelayMs: 1000,
    factor: 3,
    jitter: "full",
    retries: 5,
    onRetry: (e, a, ms) => waits.push([a, ms]),
  });
  const ceilings = [4, 12, 36];
  waits.forEach(([attempt, ms]) => assert.ok(ms >= 0 && ms <= ceilings[attempt], `attempt ${attempt} waited ${ms}`));
});

test("StopRetry rethrows the wrapped error immediately", async () => {
  let calls = 0;
  const cause = new Error("fatal config error");
  await assert.rejects(
    withRetry(async () => (calls++, Promise.reject(new StopRetry(cause))), FASTR),
    (err) => err === cause
  );
  assert.equal(calls, 1);
});

test("StopRetry with a message throws the StopRetry itself", async () => {
  await assert.rejects(
    withRetry(async () => Promise.reject(new StopRetry("give up")), FASTR),
    (err) => err instanceof StopRetry && err.message === "give up"
  );
});
