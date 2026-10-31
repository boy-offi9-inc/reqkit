const test = require("node:test");
const assert = require("node:assert/strict");
const { retryAfterAware, parseRetryAfter, getWaitMsFromHeaders } = require("../src/retryAfterAware");
const { RetryAbortedError } = require("../src/withRetry");

function fakeHeaders(obj) {
  return { get: (key) => obj[key.toLowerCase()] ?? null };
}

test("parseRetryAfter handles integer seconds", () => {
  assert.equal(parseRetryAfter("2"), 2000);
});

test("parseRetryAfter handles HTTP-date format", () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms > 4000 && ms <= 5000);
});

test("parseRetryAfter returns null for garbage input", () => {
  assert.equal(parseRetryAfter("not-a-real-value-at-all"), null);
  assert.equal(parseRetryAfter(null), null);
});

test("getWaitMsFromHeaders prefers Retry-After over X-RateLimit-Reset", () => {
  const headers = fakeHeaders({ "retry-after": "1", "x-ratelimit-reset": "9999999999" });
  assert.equal(getWaitMsFromHeaders(headers), 1000);
});

test("getWaitMsFromHeaders falls back to X-RateLimit-Reset (epoch seconds)", () => {
  const resetAt = Math.floor(Date.now() / 1000) + 3;
  const headers = fakeHeaders({ "x-ratelimit-reset": String(resetAt) });
  const waitMs = getWaitMsFromHeaders(headers);
  assert.ok(waitMs > 2000 && waitMs <= 3000);
});

test("retryAfterAware returns immediately on a non-retryable status", async () => {
  let calls = 0;
  const response = await retryAfterAware(async () => {
    calls++;
    return { status: 200, headers: fakeHeaders({}) };
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test("retryAfterAware retries on 429 and respects Retry-After", async () => {
  let calls = 0;
  const response = await retryAfterAware(
    async () => {
      calls++;
      if (calls === 1) {
        return { status: 429, headers: fakeHeaders({ "retry-after": "0" }) };
      }
      return { status: 200, headers: fakeHeaders({}) };
    },
    { retries: 3 }
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("retryAfterAware gives up after max retries and returns last response", async () => {
  let calls = 0;
  const response = await retryAfterAware(
    async () => {
      calls++;
      return { status: 429, headers: fakeHeaders({ "retry-after": "0" }) };
    },
    { retries: 2 }
  );
  assert.equal(response.status, 429);
  assert.equal(calls, 3);
});

test("parseRetryAfter ignores empty / whitespace-only values instead of returning 0", () => {
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter("   "), null);
  assert.equal(parseRetryAfter(" 3 "), 3000);
  assert.equal(parseRetryAfter("0"), 0);
});

test("retryAfterAware cancels the body of a response it is about to retry", async () => {
  let cancelled = 0;
  let calls = 0;
  await retryAfterAware(
    async () => {
      calls++;
      if (calls === 1) {
        return {
          status: 429,
          headers: fakeHeaders({ "retry-after": "0" }),
          bodyUsed: false,
          body: { cancel: async () => void cancelled++ },
        };
      }
      return { status: 200, headers: fakeHeaders({}) };
    },
    { retries: 2 }
  );
  assert.equal(cancelled, 1);
});

test("retryAfterAware does not cancel the body of the final response it returns", async () => {
  let cancelled = 0;
  const response = await retryAfterAware(
    async () => ({
      status: 429,
      headers: fakeHeaders({ "retry-after": "0" }),
      bodyUsed: false,
      body: { cancel: async () => void cancelled++ },
    }),
    { retries: 1 }
  );
  assert.equal(response.status, 429);
  assert.equal(cancelled, 1); // only the first (retried) response, not the returned one
});

test("retryAfterAware survives a body that cannot be cancelled", async () => {
  let calls = 0;
  const response = await retryAfterAware(
    async () => {
      calls++;
      if (calls === 1) {
        return {
          status: 503,
          headers: fakeHeaders({ "retry-after": "0" }),
          body: { cancel: async () => Promise.reject(new TypeError("locked")) },
        };
      }
      return { status: 200, headers: fakeHeaders({}) };
    },
    { retries: 1 }
  );
  assert.equal(response.status, 200);
});

test("retryAfterAware retries thrown network errors", async () => {
  let calls = 0;
  const seen = [];
  const response = await retryAfterAware(
    async () => {
      calls++;
      if (calls < 3) {
        const err = new TypeError("fetch failed");
        err.cause = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        throw err;
      }
      return { status: 200, headers: fakeHeaders({}) };
    },
    { retries: 3, fallbackDelayMs: 1, onRetryError: (err, waitMs, attempt) => seen.push(attempt) }
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(seen, [0, 1]);
});

test("retryAfterAware does not retry non-network thrown errors", async () => {
  let calls = 0;
  await assert.rejects(
    retryAfterAware(
      async () => {
        calls++;
        throw new Error("bug in my code");
      },
      { retries: 3, fallbackDelayMs: 1 }
    ),
    /bug in my code/
  );
  assert.equal(calls, 1);
});

test("retryAfterAware rethrows the last network error once retries run out", async () => {
  let calls = 0;
  await assert.rejects(
    retryAfterAware(
      async () => {
        calls++;
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
      { retries: 2, fallbackDelayMs: 1 }
    ),
    /reset/
  );
  assert.equal(calls, 3);
});

test("retryAfterAware honors a custom shouldRetryError", async () => {
  let calls = 0;
  await retryAfterAware(
    async () => {
      calls++;
      if (calls === 1) throw new Error("flaky");
      return { status: 200, headers: fakeHeaders({}) };
    },
    { fallbackDelayMs: 1, shouldRetryError: () => true }
  );
  assert.equal(calls, 2);
});

test("retryAfterAware stops mid-backoff when the signal aborts", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const promise = retryAfterAware(async () => ({ status: 429, headers: fakeHeaders({ "retry-after": "30" }) }), {
    retries: 3,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, RetryAbortedError);
  assert.ok(Date.now() - started < 1000);
});

test("retryAfterAware throws RetryAbortedError for an already-aborted signal without calling fn", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    retryAfterAware(async () => (calls++, { status: 200, headers: fakeHeaders({}) }), { signal: controller.signal }),
    RetryAbortedError
  );
  assert.equal(calls, 0);
});
