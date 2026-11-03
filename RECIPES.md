# Recipes

reqkit is a set of small functions, so it slots *around* the HTTP client you already use. Each recipe below keeps your client and adds just the piece you're missing.

> The snippets use only reqkit's documented API plus each library's documented hooks/interceptors. The reqkit side is covered by its test suite; the third-party libraries (axios, ky, got) aren't installed in reqkit's CI, so if a snippet drifts with a new major version of one of them, please open an issue.

- [axios](#axios) · [ky](#ky) · [got](#got) · [undici / node-fetch / any fetch](#undici--node-fetch--any-fetch)
- [Deno, Bun, Cloudflare Workers, browsers](#deno-bun-cloudflare-workers-browsers)
- [Testing your own code](#testing-your-own-code)
- [LLM streaming (SSE)](#llm-streaming-sse)

A tiny helper used in the axios and got recipes — reqkit reads headers through `.get(name)`, and those libraries hand you plain objects:

```js
const asHeaders = (h) => ({
  get: (name) => (typeof h?.get === "function" ? h.get(name) : h?.[name.toLowerCase()]) ?? null,
});
```

---

## axios

axios throws on 4xx/5xx, so retry decisions go in `shouldRetry`. `normalizeError` already understands axios errors (`status`, `isNetworkError`, `isTimeout`, cancellation).

**Retries that honor `Retry-After`:**

```js
import axios from "axios";
import { withRetry, normalizeError, getWaitMsFromHeaders } from "@boy-offi9-inc/reqkit";

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function getWithRetry(url, config) {
  return withRetry(() => axios.get(url, config), {
    retries: 3,
    shouldRetry: (err) => {
      const n = normalizeError(err);
      return !n.isAborted && (n.isNetworkError || n.isTimeout || RETRY_STATUS.has(n.status));
    },
    // use the server's Retry-After when it sent one, otherwise reqkit's backoff
    calculateDelay: ({ error, delayMs }) => {
      const wait = getWaitMsFromHeaders(asHeaders(error?.response?.headers));
      return wait === null ? delayMs : Math.min(wait, 60_000);
    },
  });
}
```

Only retry idempotent requests (GET/PUT/DELETE) this way — a retried POST can run twice.

**Proactive rate limiting** (slow down *before* the 429) with interceptors:

```js
import { createRateLimiter } from "@boy-offi9-inc/reqkit";

const rl = createRateLimiter({ requests: 10, perMs: 1000 });
const api = axios.create({ baseURL: "https://api.example.com" });

api.interceptors.request.use(async (config) => {
  await rl.acquire({ signal: config.signal });
  return config;
});
api.interceptors.response.use(
  (res) => {
    rl.update({ status: res.status, headers: asHeaders(res.headers) }); // learns X-RateLimit-* / Retry-After
    return res;
  },
  (err) => {
    if (err.response) rl.update({ status: err.response.status, headers: asHeaders(err.response.headers) });
    throw err;
  }
);
```

**Circuit breaker:**

```js
import { createCircuitBreaker, CircuitOpenError } from "@boy-offi9-inc/reqkit";

const breaker = createCircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  // count network errors and 5xx — not 404s or user cancellations
  isFailure: (err, isError) => isError && !axios.isCancel(err) && (!err.response || err.response.status >= 500),
});

try {
  const { data } = await breaker.run(() => api.get("/users"));
} catch (err) {
  if (err instanceof CircuitOpenError) showOfflineBanner(err.retryAfterMs);
}
```

---

## ky

ky already retries, so the best additions are the pieces it doesn't have: a **rate limiter** and a **circuit breaker**. ky's hooks make the limiter a few lines:

```js
import ky from "ky";
import { createRateLimiter, createCircuitBreaker, readSSE } from "@boy-offi9-inc/reqkit";

const rl = createRateLimiter({ requests: 5, perMs: 1000 });

const api = ky.create({
  prefixUrl: "https://api.example.com",
  hooks: {
    beforeRequest: [async (request) => { await rl.acquire({ signal: request.signal }); }],
    afterResponse: [(request, options, response) => { rl.update(response); }], // ky gives you a real Response
  },
});

const breaker = createCircuitBreaker({
  // ky throws HTTPError for non-2xx with `err.response`
  isFailure: (err, isError) => isError && err.name !== "AbortError" && (!err.response || err.response.status >= 500),
});

const users = await breaker.run(() => api.get("users").json());
```

Prefer reqkit's retries over ky's? Set `retry: 0` on the ky instance and wrap the call in `withRetry` (with `shouldRetry` using `normalizeError`, as in the axios recipe).

---

## got

```js
import got from "got";
import { createRateLimiter } from "@boy-offi9-inc/reqkit";

const rl = createRateLimiter({ requests: 10, perMs: 1000 });

const api = got.extend({
  prefixUrl: "https://api.example.com",
  hooks: {
    beforeRequest: [async () => { await rl.acquire(); }],
    afterResponse: [
      (response) => {
        rl.update({ status: response.statusCode, headers: asHeaders(response.headers) });
        return response;
      },
    ],
  },
});
```

got has its own retry logic (it only retries idempotent methods by default, and honors `Retry-After`), so there's usually no need to add reqkit's.

---

## undici / node-fetch / any fetch

`createFetch` takes any fetch-compatible function:

```js
import { fetch as undiciFetch, Agent } from "undici";
import { createFetch } from "@boy-offi9-inc/reqkit";

const dispatcher = new Agent({ connections: 20 });
const api = createFetch({
  baseUrl: "https://api.example.com",
  fetch: (url, init) => undiciFetch(url, { ...init, dispatcher }),
  retry: { retries: 3 },
  cache: { ttl: 30_000 },
});
```

The standalone helpers (`withRetry`, `withTimeout`, `createLimiter`, `createRateLimiter`, `downloadResumable`, …) don't care which client sits underneath.

---

## Deno, Bun, Cloudflare Workers, browsers

reqkit only uses web-standard APIs, and the package ships a dependency-free ESM bundle at `@boy-offi9-inc/reqkit/browser`.

```js
// Deno
import { createFetch } from "npm:@boy-offi9-inc/reqkit";

// Bun / Node / Workers (via wrangler's bundler)
import { createFetch } from "@boy-offi9-inc/reqkit";

// Browser, no build step — pin the version
import { createFetch } from "https://cdn.jsdelivr.net/npm/@boy-offi9-inc/reqkit@0.5.0/dist/reqkit.mjs";
```

Notes: in Workers the in-memory cache and rate limiter live **per isolate**, so treat them as best-effort or pass a `store` backed by KV / Durable Objects. In browsers, `cache` is separate from the HTTP cache the browser already keeps. Node 18+ is the primary, fully tested target; CI also smoke-tests the bundle on Deno, Bun and headless Chromium (those jobs are new — if one is red, open an issue).

---

## Testing your own code

Take `fetch` as a parameter (or pass it to `createFetch`) and hand in `createMockFetch` during tests:

```js
import { createMockFetch, createFetch } from "@boy-offi9-inc/reqkit";

test("recovers from a flaky upstream", async () => {
  const mock = createMockFetch();
  mock.get("/profile")
    .failOnce(mock.networkError())                                   // connection refused
    .replyOnce(503, "busy", { headers: { "retry-after": "0" } })     // then overloaded
    .reply(200, { name: "Ada" });                                    // then fine

  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://api.test", retry: { baseDelayMs: 1 } });

  expect(await api.json("/profile")).toEqual({ name: "Ada" });
  expect(mock.calls).toHaveLength(3);
});

test("gives up politely on a hanging server", async () => {
  const mock = createMockFetch();
  mock.get("/slow").reply(200, "late", { delayMs: 5_000 }); // delayMs respects AbortSignal
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://api.test", timeout: 50, retry: false });
  await expect(api("/slow")).rejects.toMatchObject({ name: "TimeoutError" });
});
```

---

## LLM streaming (SSE)

```js
import { readSSE } from "@boy-offi9-inc/reqkit";

const res = await fetch("https://api.example.com/v1/chat", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "text/event-stream" },
  body: JSON.stringify({ prompt: "Hello", stream: true }),
  signal, // abort → the stream is cancelled and the connection released
});

let text = "";
for await (const { data } of readSSE(res, { signal })) {
  if (data === "[DONE]") break;
  text += JSON.parse(data).token;
  render(text);
}
```

Want the request itself to be retried, timed out and rate limited? Make it through `createFetch` instead — it returns the same `Response`, so `readSSE(res)` works unchanged.
