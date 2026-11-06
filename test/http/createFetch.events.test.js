const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");
const { createFetch, createMockFetch, HTTPError } = require("../../src");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { baseDelayMs: 1, maxDelayMs: 2 };

function collector() {
  const events = [];
  return { events, onEvent: (e) => events.push(e), types: () => events.map((e) => e.type), of: (t) => events.filter((e) => e.type === t) };
}

test("onEvent: a simple request emits request → attempt → response", async () => {
  const mock = createMockFetch();
  mock.get("/a").reply(200, { ok: true });
  const c = collector();
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", onEvent: c.onEvent });
  await api("/a", { query: { n: 1 } });

  assert.deepEqual(c.types(), ["request", "attempt", "response"]);
  assert.deepEqual(c.events[0], { type: "request", url: "https://t.test/a?n=1", method: "GET" });
  assert.deepEqual(c.events[1], { type: "attempt", url: "https://t.test/a?n=1", method: "GET", attempt: 1 });
  const response = c.events[2];
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.equal(response.attempts, 1);
  assert.equal(response.cache, undefined);
  assert.ok(Number.isFinite(response.durationMs) && response.durationMs >= 0);
});

test("onEvent: retries are reported with their reason, status and delay", async () => {
  const mock = createMockFetch();
  mock.get("/a").replyOnce(503, "busy", { headers: { "retry-after": "0" } }).failOnce(mock.networkError()).reply(200, "ok");
  const c = collector();
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", retry: { retries: 3, ...FAST }, onEvent: c.onEvent });
  await api("/a");

  const retries = c.of("retry");
  assert.equal(retries.length, 2);
  assert.equal(retries[0].reason, "status");
  assert.equal(retries[0].status, 503);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[1].reason, "error");
  assert.equal(retries[1].attempt, 2);
  assert.equal(retries[1].error.name, "TypeError");
  assert.ok(retries.every((r) => Number.isFinite(r.delayMs)));
  assert.equal(c.of("attempt").length, 3);
  assert.equal(c.of("response")[0].attempts, 3);
});

test("onEvent: your own retry.onRetry still runs alongside onEvent", async () => {
  const mock = createMockFetch();
  mock.get("/a").replyOnce(500).reply(200, "ok");
  const seen = [];
  const c = collector();
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", retry: { ...FAST, onRetry: (e, attempt, ms, ctx) => seen.push(ctx.status) }, onEvent: c.onEvent });
  await api("/a");
  assert.deepEqual(seen, [500]);
  assert.equal(c.of("retry").length, 1);
});

test("onEvent: a request that fails emits `error` (and no `response`)", async () => {
  const mock = createMockFetch();
  mock.get("/a").fail(mock.networkError());
  const c = collector();
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", retry: false, onEvent: c.onEvent });
  await assert.rejects(api("/a"));

  assert.deepEqual(c.types(), ["request", "attempt", "error"]);
  const error = c.events[2];
  assert.equal(error.error.name, "TypeError");
  assert.equal(error.attempts, 1);
  assert.equal(error.url, "https://t.test/a");
  assert.equal(error.method, "GET");
});

test("onEvent: a non-2xx is a `response` event (with its status), not an `error`", async () => {
  const mock = createMockFetch();
  mock.get("/a").reply(404, "nope");
  const c = collector();
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", retry: false, onEvent: c.onEvent });
  await assert.rejects(api("/a"), HTTPError);

  assert.deepEqual(c.types(), ["request", "attempt", "response"]);
  assert.equal(c.of("response")[0].status, 404);
  assert.equal(c.of("response")[0].ok, false);
});

test("onEvent: a user abort is reported as an `error` event", async () => {
  const srv = await startServer(() => {});
  try {
    const c = collector();
    const api = createFetch({ baseUrl: srv.url, timeout: false, retry: false, onEvent: c.onEvent });
    const ctl = new AbortController();
    const p = api("/x", { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(p);
    assert.equal(c.of("error")[0].error.name, "AbortError");
  } finally {
    await srv.close();
  }
});

test("onEvent: cache activity is reported, and the response says how it was served", async () => {
  const mock = createMockFetch();
  mock.get("/a").reply(200, "x");
  const c = collector();
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", cache: { ttl: 5000 }, onEvent: c.onEvent });
  await api("/a");
  await sleep(15);
  await api("/a");

  assert.deepEqual(c.of("cache").map((e) => e.event), ["miss", "store", "hit"]);
  assert.deepEqual(c.of("response").map((e) => e.cache), ["miss", "hit"]);
  assert.equal(c.of("response")[1].attempts, 0, "a cache hit makes no network attempt");
});

test("onEvent: stale-if-error shows up as a cache event and in the response", async () => {
  const mock = createMockFetch();
  mock.get("/a").replyOnce(200, "x").reply(500, "down");
  const c = collector();
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", retry: false, cache: { ttl: 10, staleIfError: 5000 }, onEvent: c.onEvent });
  await api("/a");
  await sleep(30);
  await api("/a");
  assert.ok(c.of("cache").some((e) => e.event === "stale-if-error"));
  assert.equal(c.of("response").at(-1).cache, "stale-if-error");
});

test("onEvent: waiting on the rate limiter is reported with how long it took", async () => {
  const mock = createMockFetch();
  mock.get("/a").reply(200, "x");
  const c = collector();
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", rateLimit: { requests: 1, perMs: 80 }, onEvent: c.onEvent });
  await api("/a");
  await api("/a");
  const waits = c.of("ratelimit");
  assert.equal(waits.length, 1, "only the second request had to wait");
  assert.ok(waits[0].waitedMs >= 50, `waited ${waits[0].waitedMs}ms`);
});

test("onEvent: circuit state changes are reported per origin (and your own onStateChange still fires)", async () => {
  const mock = createMockFetch();
  mock.get("/a").reply(500, "x");
  const c = collector();
  const own = [];
  const api = createFetch({
    fetch: mock.fetch,
    baseUrl: "https://t.test",
    retry: false,
    throwHttpErrors: false,
    circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 5000, onStateChange: (s) => own.push(s) },
    onEvent: c.onEvent,
  });
  await api("/a");
  await api("/a");
  assert.deepEqual(c.of("circuit"), [{ type: "circuit", origin: "https://t.test", state: "open", previous: "closed" }]);
  assert.deepEqual(own, ["open"]);
});

test("onEvent: token refreshes are reported as refreshed / reused", async () => {
  const mock = createMockFetch();
  mock.get("/a").replyWith((call) => (call.headers.authorization === "Bearer fresh" ? { status: 200, body: "ok" } : { status: 401 }));
  const c = collector();
  let token = "old";
  const api = createFetch({
    fetch: mock.fetch,
    baseUrl: "https://t.test",
    retry: false,
    auth: { getToken: () => token, refresh: async () => { await sleep(20); token = "fresh"; } },
    onEvent: c.onEvent,
  });
  await Promise.all([api("/a"), api("/a"), api("/a")]);
  const outcomes = c.of("auth").map((e) => e.outcome);
  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every((o) => o === "refreshed" || o === "reused"));
  assert.ok(outcomes.includes("refreshed"));
});

test("onEvent: a failed refresh is reported as `failed`", async () => {
  const mock = createMockFetch();
  mock.get("/a").reply(401, "no");
  const c = collector();
  const api = createFetch({
    fetch: mock.fetch,
    baseUrl: "https://t.test",
    retry: false,
    auth: { getToken: () => "t", refresh: () => { throw new Error("revoked"); } },
    onEvent: c.onEvent,
  });
  await assert.rejects(api("/a"), /revoked/);
  const auth = c.of("auth")[0];
  assert.equal(auth.outcome, "failed");
  assert.equal(auth.error.message, "revoked");
});

test("onEvent: a handler that throws or rejects never breaks the request", async () => {
  const mock = createMockFetch();
  mock.get("/a").reply(200, "fine");
  const throwing = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", onEvent: () => { throw new Error("logger crashed"); } });
  assert.equal(await (await throwing("/a")).text(), "fine");
  const rejecting = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", onEvent: async () => { throw new Error("async logger crashed"); } });
  assert.equal(await (await rejecting("/a")).text(), "fine");
  await sleep(5); // no unhandled rejection
});

test("onEvent: extend() children inherit it, and can replace it", async () => {
  const mock = createMockFetch();
  mock.get("/a").reply(200, "x");
  const parent = collector();
  const child = collector();
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", onEvent: parent.onEvent });
  await api.extend({ timeout: 5000 })("/a");
  assert.ok(parent.events.length > 0, "inherited");
  const before = parent.events.length;
  await api.extend({ onEvent: child.onEvent })("/a");
  assert.equal(parent.events.length, before, "replaced");
  assert.ok(child.events.length > 0);
});

test("onEvent works with plain fetch semantics: request ids can be correlated via url + attempt", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) {
      res.statusCode = 503;
      res.setHeader("retry-after", "0");
      return res.end("busy");
    }
    res.end("ok");
  });
  try {
    const c = collector();
    const api = createFetch({ baseUrl: srv.url, retry: { retries: 2, ...FAST }, onEvent: c.onEvent });
    await api("/same");
    assert.deepEqual(c.of("attempt").map((e) => e.attempt), [1, 2]);
    assert.equal(c.of("response")[0].attempts, 2);
  } finally {
    await srv.close();
  }
});
