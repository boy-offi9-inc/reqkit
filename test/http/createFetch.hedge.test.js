const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");
const { createFetch, createMockFetch } = require("../../src");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { baseDelayMs: 1, maxDelayMs: 2 };

// A server whose first request is slow and later ones are fast. Records which
// requests were cut off by the client (the connection closed before we answered).
async function slowThenFast({ slowMs = 400, slowCount = 1 } = {}) {
  const cancelled = [];
  const srv = await startServer((req, res, hit) => {
    const slow = hit <= slowCount;
    const timer = setTimeout(() => res.end(slow ? `slow-${hit}` : `fast-${hit}`), slow ? slowMs : 5);
    res.on("close", () => {
      if (!res.writableEnded) {
        clearTimeout(timer);
        cancelled.push(hit);
      }
    });
  });
  return { srv, cancelled };
}

test("hedge: a slow first request is beaten by a backup, and the slow one is cancelled", async () => {
  const { srv, cancelled } = await slowThenFast();
  try {
    const events = [];
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: 50 }, onEvent: (e) => events.push(e) });
    const started = Date.now();
    const res = await api("/x");
    assert.equal(await res.text(), "fast-2");
    assert.ok(Date.now() - started < 300, `took ${Date.now() - started}ms instead of ~400`);
    assert.equal(srv.hits(), 2);

    await sleep(30);
    assert.deepEqual(cancelled, [1], "the server saw request #1 get cancelled");

    const hedge = events.find((e) => e.type === "hedge");
    assert.equal(hedge.index, 1);
    assert.ok(hedge.afterMs >= 40);
    const response = events.find((e) => e.type === "response");
    assert.equal(response.hedges, 1);
    assert.equal(response.hedgeWon, true);
  } finally {
    await srv.close();
  }
});

test("hedge: a fast response never sends a backup", async () => {
  const srv = await startServer((req, res) => res.end("quick"));
  try {
    const events = [];
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: 200 }, onEvent: (e) => events.push(e) });
    await api("/x");
    await sleep(250);
    assert.equal(srv.hits(), 1);
    assert.equal(events.find((e) => e.type === "response").hedges, 0);
    assert.equal(events.find((e) => e.type === "response").hedgeWon, false);
  } finally {
    await srv.close();
  }
});

test("hedge: the original can still win after a backup was sent", async () => {
  const srv = await startServer((req, res, hit) => setTimeout(() => res.end(`r${hit}`), hit === 1 ? 90 : 400));
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: 40 } });
    assert.equal(await (await api("/x")).text(), "r1");
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("hedge: only idempotent methods are hedged", async () => {
  const srv = await startServer((req, res) => setTimeout(() => res.end("ok"), 120));
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: 30 } });
    await api("/x", { method: "POST", json: { a: 1 } });
    assert.equal(srv.hits(), 1, "a POST is never sent twice");
  } finally {
    await srv.close();
  }
});

test("hedge: a POST with an Idempotency-Key may be hedged", async () => {
  const { srv } = await slowThenFast();
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: 40 } });
    const res = await api("/x", { method: "POST", json: {}, headers: { "Idempotency-Key": "k1" } });
    assert.equal(await res.text(), "fast-2");
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("hedge: a failing first response (5xx) triggers the backup immediately", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) {
      res.statusCode = 503;
      return res.end("busy");
    }
    res.end("ok");
  });
  try {
    const started = Date.now();
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: 5000 } });
    assert.equal(await (await api("/x")).text(), "ok");
    assert.ok(Date.now() - started < 1000, "did not wait for the 5s hedge delay");
  } finally {
    await srv.close();
  }
});

test("hedge: per-request hedge:false disables it, and a per-request config enables it", async () => {
  const { srv } = await slowThenFast({ slowMs: 150 });
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: 30 } });
    await api("/x", { hedge: false });
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
  const second = await slowThenFast({ slowMs: 150 });
  try {
    const plain = createFetch({ baseUrl: second.srv.url, retry: false });
    const res = await plain("/x", { hedge: { delayMs: 30 } });
    assert.equal(await res.text(), "fast-2");
  } finally {
    await second.srv.close();
  }
});

test("hedge: maxHedges: 2 can send two backups", async () => {
  const srv = await startServer((req, res, hit) => setTimeout(() => res.end(`r${hit}`), hit <= 2 ? 500 : 5));
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: 40, maxHedges: 2 } });
    assert.equal(await (await api("/x")).text(), "r3");
    assert.equal(srv.hits(), 3);
  } finally {
    await srv.close();
  }
});

test("hedge: delayMs 'auto' hedges at your own recent latency once enough samples exist", async () => {
  const srv = await startServer((req, res, hit) => {
    // hits 1-10 are the fast "training" requests; hit 11 is the slow one; hit 12 (the hedge) is fast again
    setTimeout(() => res.end(`r${hit}`), hit === 11 ? 600 : 5);
  });
  try {
    const events = [];
    const api = createFetch({
      baseUrl: srv.url,
      retry: false,
      hedge: { delayMs: "auto", minDelayMs: 30, fallbackDelayMs: 5000 },
      onEvent: (e) => events.push(e),
    });
    for (let i = 0; i < 10; i++) await api(`/warm${i}`);
    assert.equal(events.filter((e) => e.type === "hedge").length, 0);

    const started = Date.now();
    assert.equal(await (await api("/slow")).text(), "r12");
    assert.ok(Date.now() - started < 400, `hedged after ~30ms (p95 of ~5ms, floored at minDelayMs), took ${Date.now() - started}ms`);
    const hedge = events.find((e) => e.type === "hedge");
    assert.ok(hedge.afterMs >= 25 && hedge.afterMs < 150, `hedge fired after ${hedge.afterMs}ms`);
  } finally {
    await srv.close();
  }
});

test("hedge: 'auto' uses fallbackDelayMs until it has seen enough requests", async () => {
  const srv = await startServer((req, res, hit) => setTimeout(() => res.end(`r${hit}`), hit === 1 ? 150 : 5));
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: "auto", fallbackDelayMs: 5000 } });
    assert.equal(await (await api("/x")).text(), "r1", "no samples yet → waited for the original instead of hedging at 5s");
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("hedge: hedge:true means 'auto' with defaults", async () => {
  const srv = await startServer((req, res) => res.end("ok"));
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, hedge: true });
    assert.equal(await (await api("/x")).text(), "ok");
  } finally {
    await srv.close();
  }
});

test("hedge: a user abort cancels the original and any backup", async () => {
  const cancelled = [];
  const srv = await startServer((req, res, hit) => {
    res.on("close", () => !res.writableEnded && cancelled.push(hit));
  });
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false, timeout: false, hedge: { delayMs: 30 } });
    const c = new AbortController();
    const p = api("/x", { signal: c.signal });
    setTimeout(() => c.abort(), 90);
    await assert.rejects(p, (e) => e.name === "AbortError");
    await sleep(40);
    assert.deepEqual(cancelled.sort(), [1, 2]);
  } finally {
    await srv.close();
  }
});

test("hedge: each backup goes through the rate limiter too", async () => {
  const srv = await startServer((req, res, hit) => setTimeout(() => res.end(`r${hit}`), hit === 1 ? 300 : 5));
  try {
    const events = [];
    const api = createFetch({
      baseUrl: srv.url,
      retry: false,
      hedge: { delayMs: 20 },
      rateLimit: { requests: 1, perMs: 120 },
      onEvent: (e) => events.push(e),
    });
    await api("/x");
    const longest = Math.max(0, ...events.filter((e) => e.type === "ratelimit").map((e) => e.waitedMs));
    assert.ok(longest >= 60, `the backup had to wait for its slot (longest wait ${longest}ms), so the budget isn't blown`);
  } finally {
    await srv.close();
  }
});

test("hedge: works together with retry and the mock fetch", async () => {
  const mock = createMockFetch();
  mock.get("/a").replyOnce(200, "slow", { delayMs: 300 }).reply(200, "fast");
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://t.test", retry: { retries: 1, ...FAST }, hedge: { delayMs: 30 } });
  assert.equal(await (await api("/a")).text(), "fast");
  assert.equal(mock.calls.length, 2);
});

test("hedge: extend() children keep hedging and share the latency tracker", async () => {
  const { srv } = await slowThenFast({ slowMs: 300 });
  try {
    const parent = createFetch({ baseUrl: srv.url, retry: false, hedge: { delayMs: 30 } });
    const child = parent.extend({ timeout: 5000 });
    assert.equal(await (await child("/x")).text(), "fast-2");
  } finally {
    await srv.close();
  }
});
