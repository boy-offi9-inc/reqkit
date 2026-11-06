// Playground demos. Pure logic — no DOM — so they run in the browser page *and*
// in Node tests. Every demo talks to a fake in-memory server (createMockFetch),
// so nothing here touches the network. `scale` shrinks all the waits (tests use
// a tiny scale; the page uses 1).

import {
  createFetch,
  createMockFetch,
  createRateLimiter,
  createCircuitBreaker,
  CircuitOpenError,
  downloadResumable,
  readSSE,
  streamSSE,
  paginateLinks,
} from "./reqkit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClock(log) {
  const t0 = performance.now();
  const stamp = () => `[${((performance.now() - t0) / 1000).toFixed(2)}s]`;
  const say = (text) => log(`${stamp()} ${text}`);
  return { say };
}

// Wraps a fetch so every request/response shows up in the log.
function traced(fetchFn, say) {
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    say(`→ ${init.method || "GET"} ${path}`);
    const res = await fetchFn(url, init);
    say(`← ${res.status}${res.headers.get("retry-after") ? `  (Retry-After: ${res.headers.get("retry-after")}s)` : ""}`);
    return res;
  };
}

export const demos = [
  {
    id: "retry",
    title: "Retry that obeys Retry-After",
    blurb: "The server says 503 → \"wait 1s\", then 429 → \"wait 1s\". reqkit waits exactly that long instead of guessing with blind backoff.",
    code: `const api = createFetch({
  baseUrl: "https://api.demo",
  retry: { retries: 3 },
});
await api.json("/data");`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      const wait = String(1 * scale);
      const mock = createMockFetch();
      mock
        .get("/data")
        .replyOnce(503, "busy", { headers: { "retry-after": wait } })
        .replyOnce(429, "slow down", { headers: { "retry-after": wait } })
        .reply(200, { message: "finally!" });

      const api = createFetch({
        baseUrl: "https://api.demo",
        fetch: traced(mock.fetch, say),
        retry: {
          retries: 3,
          onRetry: (err, attempt, delayMs, ctx) => say(`   retry #${attempt + 1} in ${Math.round(delayMs)}ms because of ${ctx.status}`),
        },
      });
      const data = await api.json("/data");
      say(`✓ got ${JSON.stringify(data)} after ${mock.calls.length} requests`);
      return { requests: mock.calls.length };
    },
  },

  {
    id: "ratelimit",
    title: "Proactive rate limiter",
    blurb: "Budget: 3 requests per second. Seven requests fire at once — reqkit spaces them out so the server never has to say 429.",
    code: `const api = createFetch({
  rateLimit: { requests: 3, perMs: 1000 },
});
await Promise.all(urls.map((u) => api(u)));`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      const mock = createMockFetch();
      mock.get("/ping").reply(200, "pong");
      const api = createFetch({
        baseUrl: "https://api.demo",
        fetch: async (url, init) => {
          say(`→ request ${new URL(url).searchParams.get("n")} sent`);
          return mock.fetch(url, init);
        },
        rateLimit: { requests: 3, perMs: 1000 * scale },
      });
      say("firing 7 requests at once…");
      await Promise.all(Array.from({ length: 7 }, (_, i) => api("/ping", { query: { n: i + 1 } })));
      say("✓ all done — never exceeded 3 per window");
      return { requests: mock.calls.length };
    },
  },

  {
    id: "breaker",
    title: "Circuit breaker",
    blurb: "A service starts failing. After 3 failures reqkit stops calling it and fails instantly. When it recovers, a probe closes the circuit again.",
    code: `const api = createFetch({
  retry: false,
  circuitBreaker: { failureThreshold: 3,
                    resetTimeoutMs: 800 },
});`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      let healthy = false;
      const mock = createMockFetch();
      mock.get("/svc").replyWith(() => (healthy ? { status: 200, body: "ok" } : { status: 500, body: "boom" }));

      const api = createFetch({
        baseUrl: "https://api.demo",
        fetch: traced(mock.fetch, say),
        retry: false,
        circuitBreaker: {
          failureThreshold: 3,
          resetTimeoutMs: 800 * scale,
          onStateChange: (state, prev) => say(`   ⚡ circuit ${prev} → ${state}`),
        },
      });

      let failFast = 0;
      for (let i = 1; i <= 5; i++) {
        try {
          await api("/svc");
        } catch (err) {
          if (err instanceof CircuitOpenError) {
            failFast++;
            say(`   call ${i}: failed instantly — circuit is open (no request sent)`);
          } else {
            say(`   call ${i}: ${err.message}`);
          }
        }
      }
      say("…service recovers, waiting for the reset timeout…");
      healthy = true;
      await sleep(850 * scale);
      const res = await api("/svc");
      say(`✓ probe succeeded (${res.status}) — back to normal`);
      return { failFast, requests: mock.calls.length };
    },
  },

  {
    id: "cache",
    title: "Cache with ETag revalidation",
    blurb: "First call hits the network, the second is served from memory, and after the TTL reqkit asks \"has it changed?\" — a 304 reuses the cached body.",
    code: `const api = createFetch({
  cache: { ttl: 600 },
});
await api.json("/config");`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      const mock = createMockFetch();
      mock.get("/config").replyWith((call) =>
        call.headers["if-none-match"] === '"v1"'
          ? { status: 304 }
          : { status: 200, body: { theme: "dark" }, headers: { etag: '"v1"' } }
      );
      const api = createFetch({
        baseUrl: "https://api.demo",
        fetch: traced(mock.fetch, say),
        cache: { ttl: 600 * scale, onEvent: (e) => say(`   cache ${e.type}`) },
      });

      say("call 1");
      await api.json("/config");
      await sleep(20 * scale);
      say("call 2 (right away)");
      await api.json("/config");
      say(`…waiting for the TTL to expire…`);
      await sleep(650 * scale);
      say("call 3 (stale → revalidate)");
      const data = await api.json("/config");
      say(`✓ ${JSON.stringify(data)} — 3 calls, ${mock.calls.length} network requests`);
      return { requests: mock.calls.length };
    },
  },

  {
    id: "sse",
    title: "Streaming (SSE) like an LLM",
    blurb: "readSSE turns a Server-Sent Events stream into an async loop. Tokens arrive one by one — break out early and the connection is released.",
    code: `for await (const { data } of readSSE(res)) {
  if (data === "[DONE]") break;
  text += JSON.parse(data).token;
}`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      const tokens = ["reqkit ", "streams ", "tokens ", "as ", "they ", "arrive."];
      const mock = createMockFetch();
      mock.get("/chat").replyWith(
        () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                const enc = new TextEncoder();
                for (const token of tokens) {
                  await sleep(120 * scale);
                  controller.enqueue(enc.encode(`data: ${JSON.stringify({ token })}\n\n`));
                }
                controller.enqueue(enc.encode("data: [DONE]\n\n"));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } }
          )
      );

      const res = await mock.fetch("https://api.demo/chat");
      let text = "";
      for await (const { data } of readSSE(res)) {
        if (data === "[DONE]") break;
        text += JSON.parse(data).token;
        say(`token → "${text}"`);
      }
      say("✓ stream finished");
      return { text };
    },
  },

  {
    id: "sse-reconnect",
    title: "SSE that reconnects itself",
    blurb: "The stream drops after event 3. streamSSE reconnects on its own and sends Last-Event-ID, so the server continues from event 4 — no gaps, no duplicates.",
    code: `for await (const ev of streamSSE(url, {
  stopWhen: (e) => e.data === "[DONE]",
  onReconnect: ({ lastEventId }) => ...,
})) { ... }`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      const enc = new TextEncoder();
      const mock = createMockFetch();

      mock.get("/events").replyWith((call) => {
        const from = Number(call.headers["last-event-id"] || 0);
        const chunks = [];
        const drop = from === 0;
        for (let n = from + 1; n <= (drop ? 3 : 6); n++) chunks.push(`id: ${n}\ndata: ${JSON.stringify({ n })}\n\n`);
        if (!drop) chunks.push("data: [DONE]\n\n");
        let i = 0;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (i < chunks.length) {
                await sleep(90 * scale);
                controller.enqueue(enc.encode(chunks[i++]));
              } else if (drop) {
                controller.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) }));
              } else {
                controller.close();
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        );
      });

      const seen = [];
      for await (const ev of streamSSE("https://api.demo/events", {
        fetch: traced(mock.fetch, say),
        reconnectDelayMs: 300 * scale,
        stopWhen: (e) => e.data === "[DONE]",
        onReconnect: ({ delayMs, lastEventId }) => say(`   ✂ stream dropped — reconnecting in ${Math.round(delayMs)}ms with Last-Event-ID: ${lastEventId}`),
      })) {
        if (ev.data === "[DONE]") break;
        seen.push(JSON.parse(ev.data).n);
        say(`   event id=${ev.id}`);
      }
      const clean = seen.join(",") === "1,2,3,4,5,6";
      say(`${clean ? "✓" : "✗"} received ${seen.join(", ")} over ${mock.calls.length} connections${clean ? " — no gaps, no duplicates" : ""}`);
      return { events: seen, connections: mock.calls.length, lastEventIdSent: mock.calls[1] && mock.calls[1].headers["last-event-id"] };
    },
  },

  {
    id: "auth-refresh",
    title: "Token refresh — once, not five times",
    blurb: "Five requests go out with an expired token and all get 401. reqkit refreshes the token ONCE, shares it with every waiting request, and replays all five.",
    code: `const api = createFetch({
  auth: {
    getToken: () => token,
    refresh: async () => { token = await login(); },
  },
});
await Promise.all(urls.map((u) => api.json(u)));`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      let token = "expired";
      const valid = "fresh-token";
      let refreshes = 0;
      const mock = createMockFetch();
      mock.get(/\/api\//).replyWith((call) =>
        call.headers.authorization === `Bearer ${valid}` ? { status: 200, body: { ok: true } } : { status: 401, body: "token expired" }
      );

      const api = createFetch({
        baseUrl: "https://api.demo",
        fetch: traced(mock.fetch, say),
        retry: false,
        auth: {
          getToken: () => token,
          refresh: async () => {
            refreshes++;
            say("   🔑 refreshing the token… (other requests wait for this one refresh)");
            await sleep(250 * scale);
            token = valid;
            say("   🔑 new token issued");
          },
        },
      });

      say("sending 5 requests with an expired token…");
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => api.json(`/api/item/${i + 1}`)));
      say(`✓ all ${results.length} succeeded — ${refreshes} refresh, ${mock.calls.length} requests (5 rejected + 5 replayed)`);
      return { refreshes, requests: mock.calls.length, ok: results.every((r) => r.ok) };
    },
  },

  {
    id: "pagination",
    title: "Pagination with Link headers",
    blurb: "The API has 5 pages of 10 items and sends Link headers. paginateLinks follows rel=\"next\" lazily — ask for 25 items and pages 4 and 5 are never requested.",
    code: `for await (const repo of paginateLinks(api, "/repos?page=1", {
  maxItems: 25,
})) { ... }`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      const mock = createMockFetch();
      mock.get(/\/repos/).replyWith(async (call) => {
        await sleep(60 * scale);
        const page = Number(new URL(call.url).searchParams.get("page") || 1);
        const items = Array.from({ length: 10 }, (_, i) => ({ id: (page - 1) * 10 + i + 1 }));
        const headers = page < 5 ? { link: `<https://api.demo/repos?page=${page + 1}>; rel="next", <https://api.demo/repos?page=5>; rel="last"` } : {};
        return { status: 200, body: items, headers };
      });
      const api = createFetch({ baseUrl: "https://api.demo", fetch: traced(mock.fetch, say), retry: false });

      let count = 0;
      for await (const repo of paginateLinks(api, "/repos?page=1", { maxItems: 25 })) {
        count++;
        if (count % 5 === 0) say(`   …item #${repo.id}`);
      }
      say(`✓ collected ${count} items from ${mock.calls.length} pages — pages 4 and 5 were never requested`);
      return { items: count, requests: mock.calls.length };
    },
  },

  {
    id: "stale-if-error",
    title: "A cache that survives an outage",
    blurb: "The server goes down. With staleIfError, reqkit keeps serving the last good response instead of failing — and picks up fresh data on its own once the server is back.",
    code: `const api = createFetch({
  cache: { ttl: 300, staleIfError: 60_000 },
});
await api.json("/config"); // server is down? still works`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      let healthy = true;
      let version = 1;
      const mock = createMockFetch();
      mock.get("/config").replyWith(() => (healthy ? { status: 200, body: { version } } : { status: 503, body: "service unavailable" }));

      const ttl = 200 * scale;
      const api = createFetch({
        baseUrl: "https://api.demo",
        fetch: traced(mock.fetch, say),
        retry: false,
        cache: { ttl, staleIfError: 60_000, onEvent: (e) => say(`   cache ${e.type}`) },
      });

      const versions = [];
      const call = async (label) => {
        say(label);
        const { version: v } = await api.json("/config");
        versions.push(v);
        say(`   → app received config v${v}`);
      };

      await call("call 1 (server healthy)");
      await sleep(ttl * 1.5);
      healthy = false;
      say("💥 the server goes down");
      await call("call 2 (cache expired, server returns 503)");
      await call("call 3 (still down)");
      healthy = true;
      version = 2;
      say("✅ the server recovers with a new config");
      await call("call 4");
      say(`✓ the app never saw an error: it received v${versions.join(", v")}`);
      return { versions, requests: mock.calls.length };
    },
  },

  {
    id: "events",
    title: "One hook to observe everything",
    blurb: "onEvent reports every request, attempt, retry, cache hit and response with timings — ready to feed a logger or a metrics client.",
    code: `const api = createFetch({
  onEvent: (e) => logger.info(e.type, e),
});`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      const mock = createMockFetch();
      mock.get("/orders").replyOnce(503, "busy", { headers: { "retry-after": String(0.15 * scale) } }).reply(200, [{ id: 1 }]);

      const seen = [];
      const api = createFetch({
        baseUrl: "https://api.demo",
        fetch: mock.fetch,
        cache: { ttl: 60_000 },
        onEvent: (e) => {
          seen.push(e);
          const path = e.url ? new URL(e.url).pathname : "";
          if (e.type === "request") say(`request   ${e.method} ${path}`);
          else if (e.type === "attempt") say(`attempt   #${e.attempt}`);
          else if (e.type === "retry") say(`retry     #${e.attempt} fails (${e.reason}${e.status ? " " + e.status : ""}) → waiting ${Math.round(e.delayMs)}ms`);
          else if (e.type === "cache") say(`cache     ${e.event}`);
          else if (e.type === "response") say(`response  ${e.status} in ${e.durationMs}ms · attempts=${e.attempts} · cache=${e.cache ?? "—"}`);
        },
      });

      await api.json("/orders");
      await sleep(20 * scale);
      say("— same call again —");
      await api.json("/orders");
      const responses = seen.filter((e) => e.type === "response");
      say(`✓ ${seen.length} events: the first call retried once, the second came from the cache with 0 attempts`);
      return { events: seen.length, firstAttempts: responses[0].attempts, secondCache: responses[1].cache, secondAttempts: responses[1].attempts };
    },
  },

  {
    id: "resume",
    title: "Resumable download",
    blurb: "The connection drops at ~45%. Instead of starting over, reqkit resumes with a Range request from the exact byte it stopped at.",
    code: `const bytes = await downloadResumable(url, {
  onProgress: ({ percent }) => ...,
  onRetry: (e, n, ms, { resumeFrom }) => ...,
});`,
    async run(log, { scale = 1 } = {}) {
      const { say } = makeClock(log);
      const FILE = new Uint8Array(20000).map((_, i) => i % 251);
      let call = 0;
      const mock = createMockFetch();
      mock.get("/big.bin").replyWith((req) => {
        call++;
        const m = /^bytes=(\d+)-$/.exec(req.headers.range || "");
        const start = m ? Number(m[1]) : 0;
        const body = FILE.slice(start);
        const cut = call === 1 ? Math.floor(FILE.length * 0.45) : body.length;
        let step = 0;
        const stream = new ReadableStream({
          async pull(controller) {
            // deliver in small chunks so progress is visible, then (maybe) drop
            const CHUNK = 1000;
            const sent = step * CHUNK;
            if (sent >= cut) {
              if (cut < body.length) {
                controller.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) }));
              } else controller.close();
              return;
            }
            await sleep(25 * scale);
            controller.enqueue(body.slice(sent, Math.min(sent + CHUNK, cut)));
            step++;
          },
        });
        const headers = { "content-length": String(body.length), etag: '"file-v1"' };
        if (m) headers["content-range"] = `bytes ${start}-${FILE.length - 1}/${FILE.length}`;
        return new Response(stream, { status: m ? 206 : 200, headers });
      });

      let lastBucket = -1;
      const out = await downloadResumable("https://api.demo/big.bin", {
        fetch: traced(mock.fetch, say),
        baseDelayMs: 150 * scale,
        onProgress: ({ percent }) => {
          const bucket = Math.floor(percent / 10);
          if (bucket !== lastBucket) {
            lastBucket = bucket;
            say(`   ${"█".repeat(bucket)}${"░".repeat(10 - bucket)} ${percent}%`);
          }
        },
        onRetry: (err, attempt, delayMs, { resumeFrom }) => say(`   ✂ connection dropped — resuming from byte ${resumeFrom}`),
      });
      const intact = out.length === FILE.length && out.every((b, i) => b === FILE[i]);
      say(`✓ ${out.length} bytes, ${intact ? "identical to the original" : "CORRUPT"} (${mock.calls.length} requests)`);
      return { intact, requests: mock.calls.length };
    },
  },
];
