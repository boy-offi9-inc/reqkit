const test = require("node:test");
const assert = require("node:assert/strict");
const { retryAfterAware, parseRetryAfter, getWaitMsFromHeaders } = require("../src/retryAfterAware");

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
