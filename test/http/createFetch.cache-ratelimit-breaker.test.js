const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");
const { createFetch, HTTPError, CircuitOpenError, createRateLimiter, createCircuitBreaker, createMemoryCache } = require("../../src");

const FAST = { baseDelayMs: 1, maxDelayMs: 5 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- cache ----

test("cache: serves a fresh GET from memory without hitting the network", async () => {
  const srv = await startServer((req, res, hit) => res.end(`body-${hit}`));
  try {
    const events = [];
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 5000, onEvent: (e) => events.push(e.type) } });
    assert.equal(await (await api("/x")).text(), "body-1");
    assert.equal(await (await api("/x")).text(), "body-1");
    assert.equal(await (await api("/x")).text(), "body-1");
    assert.equal(srv.hits(), 1);
    assert.deepEqual(events, ["miss", "store", "hit", "hit"]);
  } finally {
    await srv.close();
  }
});

test("cache: different URLs and different request headers get separate entries", async () => {
  const srv = await startServer((req, res) => res.end(`${req.url}|${req.headers.authorization || "-"}`));
  try {
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 5000 } });
    assert.equal(await (await api("/a")).text(), "/a|-");
    assert.equal(await (await api("/b")).text(), "/b|-");
    assert.equal(await (await api("/a", { headers: { authorization: "user1" } })).text(), "/a|user1");
    assert.equal(await (await api("/a", { headers: { authorization: "user2" } })).text(), "/a|user2");
    assert.equal(srv.hits(), 4, "a response fetched as user1 is never served to user2");
  } finally {
    await srv.close();
  }
});

test("cache: only GET is cached, and per-request cache:false bypasses it", async () => {
  const srv = await startServer((req, res, hit) => res.end(`b${hit}`));
  try {
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 5000 } });
    await api("/p", { method: "POST" });
    await api("/p", { method: "POST" });
    assert.equal(srv.hits(), 2);
    await api("/g");
    await api("/g", { cache: false });
    assert.equal(srv.hits(), 4, "cache:false always goes to the network");
    assert.equal(await (await api("/g", { cache: "reload" })).text(), "b5"); // skips the read, refreshes the entry
    assert.equal(await (await api("/g")).text(), "b5");
    assert.equal(srv.hits(), 5);
  } finally {
    await srv.close();
  }
});

test("cache: Cache-Control: no-store and non-200 responses are not stored", async () => {
  const srv = await startServer((req, res, hit) => {
    if (req.url === "/ns") res.setHeader("cache-control", "no-store");
    if (req.url === "/nf") res.statusCode = 404;
    res.end(`b${hit}`);
  });
  try {
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 5000 }, throwHttpErrors: false });
    await api("/ns");
    await api("/ns");
    await api("/nf");
    await api("/nf");
    assert.equal(srv.hits(), 4);
  } finally {
    await srv.close();
  }
});

test("cache: after the TTL it revalidates with If-None-Match and reuses the body on 304", async () => {
  const seen = [];
  const srv = await startServer((req, res) => {
    seen.push(req.headers["if-none-match"]);
    if (req.headers["if-none-match"] === '"v1"') {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader("etag", '"v1"');
    res.end("payload");
  });
  try {
    const events = [];
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 30, onEvent: (e) => events.push(e.type) } });
    assert.equal(await (await api("/r")).text(), "payload");
    await sleep(60);
    const second = await api("/r");
    assert.equal(second.status, 200, "304 is turned back into the cached 200");
    assert.equal(await second.text(), "payload");
    assert.deepEqual(seen, [undefined, '"v1"']);
    assert.ok(events.includes("revalidated"));

    // the refreshed entry is fresh again → no network
    await api("/r");
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("cache: Last-Modified is used when there is no ETag", async () => {
  const lm = "Wed, 21 Oct 2015 07:28:00 GMT";
  const srv = await startServer((req, res) => {
    if (req.headers["if-modified-since"] === lm) {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader("last-modified", lm);
    res.end("lm-body");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 10 } });
    await api("/x");
    await sleep(30);
    assert.equal(await (await api("/x")).text(), "lm-body");
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("cache: a changed resource replaces the entry", async () => {
  const srv = await startServer((req, res, hit) => {
    res.setHeader("etag", `"v${hit}"`);
    res.end(`version-${hit}`);
  });
  try {
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 10 } });
    assert.equal(await (await api("/x")).text(), "version-1");
    await sleep(30);
    assert.equal(await (await api("/x")).text(), "version-2");
    assert.equal(await (await api("/x")).text(), "version-2");
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("cache: stale-while-revalidate serves the stale copy instantly and refreshes in the background", async () => {
  const srv = await startServer((req, res, hit) => {
    setTimeout(() => res.end(`v${hit}`), hit === 1 ? 0 : 60);
  });
  try {
    const events = [];
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 20, staleWhileRevalidate: 5000, onEvent: (e) => events.push(e.type) } });
    assert.equal(await (await api("/s")).text(), "v1");
    await sleep(40); // now stale
    const t0 = Date.now();
    assert.equal(await (await api("/s")).text(), "v1", "stale copy returned");
    assert.ok(Date.now() - t0 < 40, "did not wait for the slow revalidation");
    await sleep(150); // background refresh lands
    assert.equal(await (await api("/s")).text(), "v2");
    assert.ok(events.includes("stale"));
  } finally {
    await srv.close();
  }
});

test("cache: respects maxBodyBytes and a custom store", async () => {
  const srv = await startServer((req, res) => res.end("x".repeat(500)));
  try {
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 5000, maxBodyBytes: 100 } });
    await api("/big");
    await api("/big");
    assert.equal(srv.hits(), 2, "too big to cache");

    const store = createMemoryCache({ maxEntries: 5 });
    const api2 = createFetch({ baseUrl: srv.url, cache: { ttl: 5000, store } });
    await api2("/a");
    await sleep(10);
    assert.equal(store.size, 1);
  } finally {
    await srv.close();
  }
});

test("cache: the cached Response is independent each time (bodies can be read repeatedly)", async () => {
  const srv = await startServer((req, res) => res.end('{"n":1}'));
  try {
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 5000 } });
    assert.deepEqual(await api.json("/j"), { n: 1 });
    assert.deepEqual(await api.json("/j"), { n: 1 });
    assert.deepEqual(await api.json("/j"), { n: 1 });
  } finally {
    await srv.close();
  }
});

test("cache: extend() children share the parent's cache", async () => {
  const srv = await startServer((req, res, hit) => res.end(`b${hit}`));
  try {
    const api = createFetch({ baseUrl: srv.url, cache: { ttl: 5000 } });
    const child = api.extend({ timeout: 5000 });
    await api("/x");
    assert.equal(await (await child("/x")).text(), "b1");
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

// ----------------------------------------------------------- rate limit ----

test("rateLimit: a budget spaces requests out", async () => {
  const stamps = [];
  const srv = await startServer((req, res) => (stamps.push(Date.now()), res.end("ok")));
  try {
    const api = createFetch({ baseUrl: srv.url, rateLimit: { requests: 2, perMs: 100 } });
    const t0 = Date.now();
    await Promise.all([api("/1"), api("/2"), api("/3")]);
    assert.ok(Date.now() - t0 >= 90, `third request waited (${Date.now() - t0}ms)`);
    assert.equal(stamps.length, 3);
  } finally {
    await srv.close();
  }
});

test("rateLimit: learns from X-RateLimit headers and pauses before the next call", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) {
      res.setHeader("x-ratelimit-remaining", "0");
      res.setHeader("x-ratelimit-reset", "0.15"); // delta seconds
    }
    res.end("ok");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, rateLimit: true });
    await api("/a");
    const t0 = Date.now();
    await api("/b");
    assert.ok(Date.now() - t0 >= 120, `waited ${Date.now() - t0}ms for the reset`);
  } finally {
    await srv.close();
  }
});

test("rateLimit: a 429 with Retry-After makes the limiter hold back other callers too", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) {
      res.statusCode = 429;
      res.setHeader("retry-after", "0.15");
      return res.end("slow down");
    }
    res.end("ok");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, rateLimit: true, retry: { retries: 2, ...FAST } });
    const t0 = Date.now();
    const res = await api("/a"); // 429 → waits Retry-After → 200
    assert.equal(await res.text(), "ok");
    assert.ok(Date.now() - t0 >= 120);
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("rateLimit: a shared limiter instance spans several createFetch instances", async () => {
  const srv = await startServer((req, res) => res.end("ok"));
  try {
    const rl = createRateLimiter({ requests: 1, perMs: 100 });
    const a = createFetch({ baseUrl: srv.url, rateLimit: rl });
    const b = createFetch({ baseUrl: srv.url, rateLimit: rl });
    const t0 = Date.now();
    await Promise.all([a("/1"), b("/2")]);
    assert.ok(Date.now() - t0 >= 90);
  } finally {
    await srv.close();
  }
});

test("rateLimit: waiting for the budget does not count against the per-attempt timeout", async () => {
  const srv = await startServer((req, res) => res.end("ok"));
  try {
    const api = createFetch({ baseUrl: srv.url, timeout: 50, rateLimit: { requests: 1, perMs: 120 } });
    await api("/1");
    await api("/2"); // waits ~120ms > 50ms timeout, but must still succeed
  } finally {
    await srv.close();
  }
});

test("rateLimit: aborting while queued rejects with AbortError", async () => {
  const srv = await startServer((req, res) => res.end("ok"));
  try {
    const api = createFetch({ baseUrl: srv.url, rateLimit: { requests: 1, perMs: 5000 } });
    await api("/1");
    const c = new AbortController();
    const p = api("/2", { signal: c.signal });
    setTimeout(() => c.abort(), 20);
    await assert.rejects(p, (e) => e.name === "AbortError");
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

// ------------------------------------------------------ circuit breaker ----

test("circuitBreaker: opens after repeated 5xx and then fails fast without touching the network", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  try {
    const api = createFetch({
      baseUrl: srv.url,
      retry: false,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 5000 },
    });
    for (let i = 0; i < 3; i++) await assert.rejects(api("/x"), HTTPError);
    assert.equal(srv.hits(), 3);
    await assert.rejects(api("/x"), (e) => e instanceof CircuitOpenError);
    assert.equal(srv.hits(), 3, "no request was sent while open");
  } finally {
    await srv.close();
  }
});

test("circuitBreaker: retries stop immediately when the circuit is open", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 503;
    res.end("down");
  });
  try {
    const api = createFetch({
      baseUrl: srv.url,
      retry: { retries: 5, ...FAST },
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 5000 },
    });
    await assert.rejects(api("/x"), (e) => e instanceof CircuitOpenError);
    assert.equal(srv.hits(), 2, "tripped after 2 failures instead of using all 6 attempts");
  } finally {
    await srv.close();
  }
});

test("circuitBreaker: half-open probe closes the circuit once the service recovers", async () => {
  let healthy = false;
  const srv = await startServer((req, res) => {
    if (!healthy) res.statusCode = 500;
    res.end("x");
  });
  try {
    const states = [];
    const api = createFetch({
      baseUrl: srv.url,
      retry: false,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 40, onStateChange: (s) => states.push(s) },
    });
    await assert.rejects(api("/x"), HTTPError);
    await assert.rejects(api("/x"), CircuitOpenError);
    healthy = true;
    await sleep(60);
    assert.equal((await api("/x")).status, 200);
    assert.deepEqual(states, ["open", "half-open", "closed"]);
  } finally {
    await srv.close();
  }
});

test("circuitBreaker: breakers are per origin, so one bad host doesn't trip another", async () => {
  const bad = await startServer((req, res) => ((res.statusCode = 500), res.end("x")));
  const good = await startServer((req, res) => res.end("ok"));
  try {
    const api = createFetch({ retry: false, circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 5000 } });
    await assert.rejects(api(`${bad.url}/x`), HTTPError);
    await assert.rejects(api(`${bad.url}/x`), CircuitOpenError);
    assert.equal(await (await api(`${good.url}/x`)).text(), "ok");
  } finally {
    await bad.close();
    await good.close();
  }
});

test("circuitBreaker: a user abort is not counted as a failure", async () => {
  const srv = await startServer(() => {});
  try {
    const breaker = createCircuitBreaker({ failureThreshold: 1 });
    const api = createFetch({ baseUrl: srv.url, timeout: false, circuitBreaker: breaker, retry: false });
    const c = new AbortController();
    const p = api("/x", { signal: c.signal });
    setTimeout(() => c.abort(), 20);
    await assert.rejects(p, (e) => e.name === "AbortError");
    assert.equal(breaker.state, "closed");
  } finally {
    await srv.close();
  }
});

test("circuitBreaker: accepts a per-url function and extend() shares breakers with the parent", async () => {
  const srv = await startServer((req, res) => ((res.statusCode = 500), res.end("x")));
  try {
    const shared = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });
    const api = createFetch({ baseUrl: srv.url, retry: false, circuitBreaker: () => shared });
    await assert.rejects(api("/x"), HTTPError);
    await assert.rejects(api.extend({ timeout: 1000 })("/x"), CircuitOpenError);
  } finally {
    await srv.close();
  }
});
