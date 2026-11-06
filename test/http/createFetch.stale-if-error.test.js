const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");
const { createFetch, createMockFetch, createCircuitBreaker, CircuitOpenError, HTTPError } = require("../../src");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A server whose behavior can be switched while a test runs.
async function switchable() {
  const state = { mode: "ok", version: 1 };
  const srv = await startServer((req, res) => {
    if (state.mode === "500") {
      res.statusCode = 500;
      return res.end("boom");
    }
    if (state.mode === "404") {
      res.statusCode = 404;
      return res.end("gone");
    }
    res.end(`v${state.version}`);
  });
  return { srv, state };
}

test("stale-if-error: a 5xx is masked by the cached copy while it's within the window", async () => {
  const { srv, state } = await switchable();
  try {
    const events = [];
    const api = createFetch({ baseUrl: srv.url, retry: false, cache: { ttl: 20, staleIfError: 5000, onEvent: (e) => events.push(e.type) } });
    assert.equal(await (await api("/x")).text(), "v1");
    await sleep(40); // fresh → stale
    state.mode = "500";
    const res = await api("/x");
    assert.equal(res.status, 200, "the caller sees the old 200, not the 500");
    assert.equal(await res.text(), "v1");
    assert.ok(events.includes("stale-if-error"));
  } finally {
    await srv.close();
  }
});

test("stale-if-error: a network failure (server down) is masked too", async () => {
  const { srv } = await switchable();
  const api = createFetch({ baseUrl: srv.url, retry: false, cache: { ttl: 20, staleIfError: 5000 } });
  assert.equal(await (await api("/x")).text(), "v1");
  await sleep(40);
  await srv.close(); // the origin disappears
  assert.equal(await (await api("/x")).text(), "v1");
});

test("stale-if-error: once the window has passed the error surfaces again", async () => {
  const { srv, state } = await switchable();
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, cache: { ttl: 10, staleIfError: 60 } });
    await api("/x");
    await sleep(25);
    state.mode = "500";
    assert.equal((await api("/x")).status, 200, "still inside ttl + staleIfError");
    await sleep(80);
    await assert.rejects(api("/x"), (e) => e instanceof HTTPError && e.status === 500);
  } finally {
    await srv.close();
  }
});

test("stale-if-error is off by default", async () => {
  const { srv, state } = await switchable();
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, cache: { ttl: 10 } });
    await api("/x");
    await sleep(30);
    state.mode = "500";
    await assert.rejects(api("/x"), HTTPError);
  } finally {
    await srv.close();
  }
});

test("stale-if-error: a 4xx is a real answer and is never masked", async () => {
  const { srv, state } = await switchable();
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, cache: { ttl: 10, staleIfError: 5000 } });
    await api("/x");
    await sleep(30);
    state.mode = "404";
    await assert.rejects(api("/x"), (e) => e instanceof HTTPError && e.status === 404);
  } finally {
    await srv.close();
  }
});

test("stale-if-error: cache:'reload' means 'I need fresh data', so the error is not masked", async () => {
  const { srv, state } = await switchable();
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, cache: { ttl: 10, staleIfError: 5000 } });
    await api("/x");
    await sleep(30);
    state.mode = "500";
    await assert.rejects(api("/x", { cache: "reload" }), HTTPError);
  } finally {
    await srv.close();
  }
});

test("stale-if-error: a deliberate abort is never turned into a cached answer", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) return res.end("v1");
    // later requests hang
  });
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, timeout: false, cache: { ttl: 10, staleIfError: 5000 } });
    await api("/x");
    await sleep(30);
    const c = new AbortController();
    const p = api("/x", { signal: c.signal });
    setTimeout(() => c.abort(), 20);
    await assert.rejects(p, (e) => e.name === "AbortError");
  } finally {
    await srv.close();
  }
});

test("stale-if-error: an open circuit breaker is masked by the cached copy", async () => {
  const { srv, state } = await switchable();
  try {
    const api = createFetch({
      baseUrl: srv.url,
      retry: false,
      circuitBreaker: createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 }),
      cache: { ttl: 10, staleIfError: 5000 },
    });
    await api("/x");
    await sleep(30);
    state.mode = "500";
    assert.equal(await (await api("/x")).text(), "v1"); // 500 → masked, and trips the breaker
    const before = srv.hits();
    assert.equal(await (await api("/x")).text(), "v1"); // circuit open → fails fast → masked
    assert.equal(srv.hits(), before, "no request was sent while the circuit was open");
  } finally {
    await srv.close();
  }
});

test("stale-if-error: when the origin recovers, the fresh response replaces the stale copy", async () => {
  const { srv, state } = await switchable();
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, cache: { ttl: 10, staleIfError: 5000 } });
    await api("/x");
    await sleep(30);
    state.mode = "500";
    assert.equal(await (await api("/x")).text(), "v1");
    state.mode = "ok";
    state.version = 2;
    assert.equal(await (await api("/x")).text(), "v2");
    await sleep(15);
    assert.equal(await (await api("/x")).text(), "v2");
  } finally {
    await srv.close();
  }
});

test("stale-if-error works with the mock fetch and retries (the stale copy is used after retries give up)", async () => {
  const mock = createMockFetch();
  mock.get("/a").replyOnce(200, "cached!").reply(503, "down");
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 }, cache: { ttl: 10, staleIfError: 5000 } });
  assert.equal(await (await api("/a")).text(), "cached!");
  await sleep(30);
  const res = await api("/a");
  assert.equal(await res.text(), "cached!");
  assert.equal(mock.calls.length, 4, "1 original + 3 attempts (2 retries) before falling back");
});
