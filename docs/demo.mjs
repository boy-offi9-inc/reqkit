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
