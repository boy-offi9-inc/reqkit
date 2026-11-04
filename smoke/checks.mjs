// Runtime-agnostic smoke checks. They only use web-standard APIs, so the same
// file runs unchanged in Node, Deno, Bun and a browser page — CI uses that to
// confirm the ESM bundle works everywhere, not just on Node.

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function rejects(promise, test, message) {
  try {
    await promise;
  } catch (err) {
    assert(test(err), `${message} (rejected with ${err && err.name}: ${err && err.message})`);
    return;
  }
  throw new Error(`${message}: expected a rejection`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeChecks(r) {
  return {
    "exports are present"() {
      for (const name of [
        "withRetry", "withTimeout", "normalizeError", "createFetch", "createMockFetch", "createLimiter",
        "createRateLimiter", "createCircuitBreaker", "downloadResumable", "readSSE", "streamSSE", "paginate", "paginateLinks", "readNDJSON", "readLines",
        "withDedupe", "withProgress", "buildQuery", "parseJsonSafe", "retryAfterAware", "HTTPError",
      ]) {
        assert(typeof r[name] === "function", `${name} is exported`);
      }
    },

    async "withRetry retries thrown errors"() {
      let calls = 0;
      const value = await r.withRetry(async () => (++calls < 3 ? Promise.reject(new Error("x")) : "ok"), { baseDelayMs: 1, jitter: 0 });
      equal(value, "ok", "result");
      equal(calls, 3, "calls");
    },

    async "withRetry honors Retry-After on results"() {
      const mock = r.createMockFetch();
      mock.get("/a").replyOnce(503, "busy", { headers: { "retry-after": "0" } }).reply(200, "fine");
      const res = await r.withRetry(() => mock.fetch("https://t.test/a"), { retryStatusCodes: [503], baseDelayMs: 1 });
      equal(await res.text(), "fine", "body");
      equal(mock.calls.length, 2, "calls");
    },

    async "withTimeout aborts the signal and throws TimeoutError"() {
      let inner;
      await rejects(
        r.withTimeout((signal) => ((inner = signal), new Promise(() => {})), 20),
        (e) => e.name === "TimeoutError",
        "timeout"
      );
      assert(inner.aborted, "signal was aborted");
    },

    "normalizeError understands `fetch failed`"() {
      const err = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      const n = r.normalizeError(err);
      assert(n.isNetworkError && n.code === "ECONNREFUSED", "classified as a network error");
    },

    async "createFetch: baseUrl, json, retry, HTTPError"() {
      const mock = r.createMockFetch();
      mock.get("/u").failOnce(mock.networkError()).replyOnce(500, "x").reply(200, { id: 7 });
      mock.get("/missing").reply(404, { error: "nope" });
      const api = r.createFetch({ fetch: mock.fetch, baseUrl: "https://api.test", retry: { baseDelayMs: 1, maxDelayMs: 2 } });
      const data = await api.json("/u");
      equal(data.id, 7, "json");
      equal(mock.calls.length, 3, "retried twice");
      await rejects(api("/missing"), (e) => e instanceof r.HTTPError && e.status === 404, "HTTPError");
    },

    async "createFetch: cache serves repeat GETs from memory"() {
      const mock = r.createMockFetch();
      mock.get("/c").reply(200, { n: 1 });
      const api = r.createFetch({ fetch: mock.fetch, baseUrl: "https://api.test", cache: { ttl: 5000 } });
      await api.json("/c");
      await sleep(10);
      equal((await api.json("/c")).n, 1, "second read");
      equal(mock.calls.length, 1, "network calls");
    },

    async "createRateLimiter spaces requests out"() {
      const rl = r.createRateLimiter({ requests: 1, perMs: 60 });
      const t0 = Date.now();
      await rl.acquire();
      await rl.acquire();
      assert(Date.now() - t0 >= 50, "second acquire waited for the window");
    },

    async "createCircuitBreaker opens after failures"() {
      const cb = r.createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5000 });
      for (let i = 0; i < 2; i++) await rejects(cb.run(() => Promise.reject(new Error("down"))), () => true, "failure");
      await rejects(cb.run(async () => 1), (e) => e instanceof r.CircuitOpenError, "fails fast");
    },

    async "createLimiter caps concurrency"() {
      const limit = r.createLimiter(2);
      let running = 0;
      let peak = 0;
      await limit.map([1, 2, 3, 4, 5], async () => {
        peak = Math.max(peak, ++running);
        await sleep(5);
        running--;
      });
      equal(peak, 2, "peak concurrency");
    },

    async "readSSE parses events from a Response"() {
      const events = [];
      for await (const ev of r.readSSE(new Response("data: a\n\nevent: x\ndata: b\ndata: c\n\n"))) events.push(ev);
      equal(events.length, 2, "event count");
      equal(events[1].data, "b\nc", "multi-line data");
      equal(events[1].event, "x", "event name");
    },

    async "streamSSE reconnects with Last-Event-ID"() {
      const mock = r.createMockFetch();
      const body = (text) =>
        new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) }), {
          headers: { "content-type": "text/event-stream" },
        });
      mock.get("/events").replyWithOnce(() => body("id: a1\ndata: one\n\n")).replyWithOnce(() => body("id: a2\ndata: two\n\n")).reply(204);
      const seen = [];
      for await (const ev of r.streamSSE("https://t.test/events", { fetch: mock.fetch, reconnectDelayMs: 1, maxDelayMs: 5 })) seen.push(ev.data);
      equal(seen.join(","), "one,two", "events across reconnects");
      equal(mock.calls[1].headers["last-event-id"], "a1", "Last-Event-ID on the first reconnect");
      equal(mock.calls[2].headers["last-event-id"], "a2", "Last-Event-ID on the second reconnect");
    },

    async "createFetch auth: one refresh for concurrent 401s"() {
      const mock = r.createMockFetch();
      let token = "old";
      let refreshes = 0;
      mock.get("/me").replyWith((call) => (call.headers.authorization === "Bearer new" ? { status: 200, body: { ok: true } } : { status: 401 }));
      const api = r.createFetch({
        fetch: mock.fetch,
        baseUrl: "https://api.test",
        retry: false,
        auth: {
          getToken: () => token,
          refresh: async () => {
            refreshes++;
            await sleep(10);
            token = "new";
          },
        },
      });
      const all = await Promise.all([api.json("/me"), api.json("/me"), api.json("/me")]);
      assert(all.every((x) => x.ok), "all replayed successfully");
      equal(refreshes, 1, "refresh calls");
    },

    async "paginate / paginateLinks walk pages lazily"() {
      const pages = [[1, 2], [3, 4], [5]];
      let fetched = 0;
      const items = [];
      for await (const x of r.paginate(async (cursor) => {
        fetched++;
        const i = cursor === undefined ? 0 : cursor;
        return { items: pages[i], next: i + 1 < pages.length ? i + 1 : undefined };
      })) items.push(x);
      equal(items.join(","), "1,2,3,4,5", "items");

      fetched = 0;
      for await (const x of r.paginate(async () => (fetched++, { items: [1, 2, 3], next: "more" }), { maxItems: 2 })) void x;
      equal(fetched, 1, "stopped before fetching a second page");

      equal(r.parseLinkHeader('<https://x.test/p2>; rel="next"').next, "https://x.test/p2", "Link header");
      const mock = r.createMockFetch();
      mock.get("/p1").reply(200, [1], { headers: { link: '<https://t.test/p2>; rel="next"' } });
      mock.get("/p2").reply(200, [2]);
      const got = [];
      for await (const x of r.paginateLinks(mock.fetch, "https://t.test/p1")) got.push(x);
      equal(got.join(","), "1,2", "paginateLinks items");
    },

    async "downloadResumable resumes after a dropped connection"() {
      const FILE = new Uint8Array(3000).map((_, i) => i % 251);
      let call = 0;
      const ranges = [];
      const fakeFetch = async (url, init) => {
        call++;
        const range = /^bytes=(\d+)-$/.exec(new Headers(init.headers).get("range") || "");
        ranges.push(range && range[1]);
        const start = range ? Number(range[1]) : 0;
        const body = FILE.slice(start);
        const headers = { "content-length": String(body.length), etag: '"v1"' };
        if (range) headers["content-range"] = `bytes ${start}-${FILE.length - 1}/${FILE.length}`;
        const cut = call === 1 ? 1000 : body.length;
        // Deliver the bytes first, *then* fail (like a real dropped connection) —
        // erroring a stream in the same tick would discard what was queued.
        let sent = false;
        const stream = new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(body.slice(0, cut));
              if (cut >= body.length) controller.close();
              return;
            }
            controller.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }));
          },
        });
        return new Response(stream, { status: range ? 206 : 200, headers });
      };
      const out = await r.downloadResumable("https://x.test/f", { fetch: fakeFetch, baseDelayMs: 1 });
      equal(out.byteLength, FILE.length, "length");
      assert(out.every((b, i) => b === FILE[i]), "bytes identical");
      equal(ranges[1], "1000", "resumed from byte 1000");
    },
  };
}

/** Runs every check; returns `{ passed, failed, results }`. Never throws. */
export async function runChecks(reqkit, log = () => {}) {
  const results = [];
  for (const [name, fn] of Object.entries(makeChecks(reqkit))) {
    try {
      await fn();
      results.push({ name, ok: true });
      log(`ok   - ${name}`);
    } catch (err) {
      results.push({ name, ok: false, error: String((err && err.message) || err) });
      log(`FAIL - ${name}: ${(err && err.message) || err}`);
    }
  }
  const failed = results.filter((x) => !x.ok).length;
  return { passed: results.length - failed, failed, results };
}
