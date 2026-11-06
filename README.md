<p align="center">
  <a href="https://www.npmjs.com/package/@boy-offi9-inc/reqkit" aria-label="npm">
    <img src="https://i.ibb.co/1f63mDTg/logo-wordmark.png" alt="reqkit on npm" width="480" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@boy-offi9-inc/reqkit"><img src="https://img.shields.io/npm/v/@boy-offi9-inc/reqkit?color=CB3837&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://github.com/boy-offi9-inc/reqkit/actions/workflows/ci.yml"><img src="https://github.com/boy-offi9-inc/reqkit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node >=18">
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/module-CJS%20%2B%20ESM-blue" alt="CJS + ESM">
  <img src="https://img.shields.io/badge/types-included-3178C6?logo=typescript&logoColor=white" alt="TypeScript types included">
</p>

# reqkit

**Tiny, zero-dependency HTTP helpers for `fetch`, axios, or anything else — retries that respect `Retry-After`, timeouts that really cancel, and errors that make sense.**

Not a client, not an axios replacement. Use one function on its own, or let [`createFetch`](#createfetchdefaults) wire them together. You always get a plain `Response` back.

```js
import { createFetch } from "@boy-offi9-inc/reqkit";

const api = createFetch({
  baseUrl: "https://api.example.com/v1",
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
  timeout: 10_000, // per attempt
});

const user = await api.json("/users/1", { query: { expand: "team" } });
// retries network errors, timeouts and 429/5xx, waits for Retry-After,
// doesn't retry a POST unless you opt in, throws HTTPError on non-2xx
```

Or take just the pieces you want:

```js
import { createLimiter, withRetry, withTimeout } from "@boy-offi9-inc/reqkit";

const limit = createLimiter(4); // 4 downloads at a time
const pages = await limit.map(urls, (url) =>
  withRetry(
    () => withTimeout((signal) => fetch(url, { signal }), 8000),
    { retryStatusCodes: [429, 503] } // and it waits for Retry-After
  )
);
```

## Install

```bash
npm install @boy-offi9-inc/reqkit
```

```js
import { createFetch, withRetry } from "@boy-offi9-inc/reqkit";      // ESM
const { createFetch, withRetry } = require("@boy-offi9-inc/reqkit");  // CommonJS
```

Requires Node 18+. TypeScript types are included.

## Pick what you need

| You want to… | Use |
|---|---|
| Retry on errors *and* bad statuses, honoring `Retry-After` | [`withRetry`](#withretryfn-opts) / [`retryAfterAware`](#retryafterawarefn-opts) |
| Time out *and actually cancel* the request | [`withTimeout`](#withtimeoutfn-ms-opts) |
| One error shape from fetch, axios and node (incl. `fetch failed`) | [`normalizeError`](#normalizeerrorerr) |
| Parse JSON without try/catch | [`parseJsonSafe`](#parsejsonsafeinput) |
| Build a query string from an object | [`buildQuery`](#buildqueryparams) |
| Download progress and size caps for any stream | [`withProgress`](#withprogressresponse-onprogress-opts) |
| Merge identical concurrent calls into one | [`withDedupe`](#withdedupefn-opts) |
| Run N things at a time | [`createLimiter`](#createlimiterconcurrency) |
| Slow down *before* the server says 429 (obey `X-RateLimit-*`) | [`createRateLimiter`](#createratelimiteropts) |
| Stop hammering a service that keeps failing | [`createCircuitBreaker`](#createcircuitbreakeropts) |
| Cache GETs (TTL, stale-while-revalidate, ETag/304) | [`createFetch` → `cache`](#caching) |
| Attach a token and refresh it on 401 — once, even with many requests in flight | [`createFetch` → `auth`](#auth-token-refresh) |
| Walk a paginated API (cursor, offset, `Link` headers) | [`paginate` / `paginateLinks`](#pagination-paginate-paginatepages-paginatelinks) |
| Resume a download after the connection drops | [`downloadResumable`](#downloadresumableurl-opts) |
| Stay connected to an SSE endpoint (auto-reconnect, `Last-Event-ID`) | [`streamSSE`](#auto-reconnecting-sse-streamsse) |
| Read SSE / NDJSON / lines from a streamed body (LLM tokens!) | [`readSSE` / `readNDJSON` / `readLines`](#streaming-readsse-readndjson-readlines) |
| Test retry/timeout code without a network | [`createMockFetch`](#createmockfetch) |
| All of the above, wired up | [`createFetch`](#createfetchdefaults) |

## Why reqkit

- **No client to adopt.** Standalone functions that compose with whatever you already use — fetch, axios, ky, got, undici.
- **It reads the server.** Retries wait for `Retry-After` / `X-RateLimit-Reset` instead of backing off blindly, and a rate limiter can slow down *before* the server says 429.
- **Safe by default.** Retries only touch idempotent methods, credentials never leave your origin, and parsers bound their memory and time on hostile input.
- **Errors that make sense.** Node's `TypeError: fetch failed`, the browser's `Failed to fetch`, axios and undici errors all normalize to one shape, and a deliberate abort is never reported as a timeout.
- **Zero dependencies**, CommonJS and ESM, hand-written TypeScript types.

## Runtime support

| Runtime | |
|---|---|
| **Node 18, 20, 22, 24** | Supported. |
| **Deno, Bun, Cloudflare Workers, browsers** | Use the dependency-free ESM bundle, `@boy-offi9-inc/reqkit/browser`. Only web-standard APIs are used. |

```js
// Deno
import { createFetch } from "npm:@boy-offi9-inc/reqkit";
```

```html
<!-- Browser, no build step (pin a version in production) -->
<script type="module">
  import { createFetch } from "https://cdn.jsdelivr.net/npm/@boy-offi9-inc/reqkit/dist/reqkit.mjs";
</script>
```

## Playground and recipes

- **[Interactive playground](https://boy-offi9-inc.github.io/reqkit/)** — every feature running in your browser against a fake server; nothing to install.
- **[Recipes](./docs/recipes.md)** — using reqkit alongside axios, ky, got and undici; testing; LLM streaming.

## Security

reqkit handles data a server controls (headers, streams, redirects), so the defaults are conservative:

- **Credentials stay on your origin.** With a `baseUrl`, the default `auth` token and the default `Authorization`, `Proxy-Authorization`, `Cookie`, `X-API-Key` and `X-Auth-Token` headers are only sent to that origin (plus any `trustedOrigins`). An absolute URL to another host doesn't receive them. Headers you pass for a specific call are always sent. Without a `baseUrl` or `trustedOrigins` there is no origin to compare against, so set at least one.
- **Pagination stays on origin.** `paginateLinks` refuses a `Link: rel="next"` that points to another origin (`code: "PAGINATE_CROSS_ORIGIN"`); allow more with `origins: [...]`.
- **Bounded input.** `readLines`, `readNDJSON` and `readSSE` run in linear time and throw `LINE_TOO_LONG` past `maxLineLength` (default 16 Mi characters); `parseLinkHeader` ignores headers over 64 KB; `withProgress` and `downloadResumable` accept `maxBytes`.
- **Safe retries.** `createFetch` retries only idempotent methods (or requests carrying an `Idempotency-Key`). Cross-origin redirects are left to `fetch`, which strips `Authorization`.

reqkit does not block requests to private or internal addresses. If you fetch user-supplied URLs on a server, validate them first. To report a vulnerability, see [SECURITY.md](./SECURITY.md).

---

## API

### `withRetry(fn, opts?)`

Retries an async function with exponential backoff + jitter. Retries on thrown errors, and — opt in — on *results* (HTTP status codes or any predicate), waiting for `Retry-After` / `X-RateLimit-Reset` when the result has headers.

```js
const data = await withRetry(
  () => fetch(url).then(r => r.json()),
  { retries: 3, baseDelayMs: 300, onRetry: (err, attempt, delayMs) => console.log(`retry ${attempt} in ${delayMs}ms`) }
);

// fetch doesn't throw on 4xx/5xx, so list the statuses to retry:
const res = await withRetry(() => fetch(url), { retryStatusCodes: [429, 500, 502, 503, 504] });
```

| Option | Default | Description |
|---|---|---|
| `retries` | `3` | max retry attempts after the first try (`Infinity` works with `maxRetryTime`) |
| `baseDelayMs` | `300` | initial delay |
| `maxDelayMs` | `10000` | backoff ceiling |
| `factor` | `2` | backoff multiplier |
| `jitter` | `0.2` | extra random fraction on top of the delay; `0` disables; `"full"` picks uniformly in `[0, delay]` (AWS "full jitter" — best when many clients retry at once) |
| `maxRetryTime` | `Infinity` | total time budget across attempts and waits; once the next wait would blow it, the last error/result is surfaced |
| `shouldRetry` | retries anything but AbortError | `(err, attempt) => boolean` — for thrown errors |
| `retryStatusCodes` | `[]` | retry when `result.status` is in this list |
| `shouldRetryResult` | — | `(result, attempt) => boolean` — retry on any result predicate |
| `respectRetryAfter` | `true` | wait for `Retry-After` / `X-RateLimit-Reset` from `result.headers` |
| `maxRetryAfterMs` | `60000` | cap on a header-provided wait |
| `calculateDelay` | — | `({ attempt, error, result, delayMs }) => ms \| false` — override the wait, or `false` to stop |
| `onRetry` | — | `(err, attempt, delayMs, { reason, result, status }) => void` — `err` is `undefined` when a result triggered the retry |
| `signal` | — | `AbortSignal` — cancels the whole retry loop, including any pending backoff wait, throwing `RetryAbortedError` (its `cause` is the last failure) |

When retries run out on a *result* (e.g. a 503), the last result is returned rather than thrown — you decide what a bad status means. Bodies of retried responses are cancelled so connections are freed.

```js
const controller = new AbortController();
const promise = withRetry(() => fetch(url), { retries: 5, signal: controller.signal });
controller.abort(); // rejects with RetryAbortedError, even mid-backoff
```

**`StopRetry`** — throw it from inside `fn` to stop retrying immediately:

```js
import { withRetry, StopRetry } from "@boy-offi9-inc/reqkit";

await withRetry(async () => {
  const res = await fetch(url);
  if (res.status === 401) throw new StopRetry(new Error("bad token")); // rethrown as-is, no more attempts
  return res;
});
```

### `withTimeout(fn, ms, opts?)`

Races an async function against a timeout, passing it an `AbortSignal` so the underlying request can actually be cancelled.

```js
const data = await withTimeout(
  signal => fetch(url, { signal }).then(r => r.json()),
  5000
);
// throws TimeoutError on timeout, regardless of whether fn cooperates with the signal
```

Pass your own `signal` to cancel from the outside too — it's linked into the one `fn` receives, and aborting it rejects with its reason even if `fn` ignores the signal. Use `ms: Infinity` to disable the timer and only link the signal. A negative or non-number `ms` throws a `TypeError`.

```js
await withTimeout(signal => fetch(url, { signal }), 5000, { signal: userController.signal });
```

### `normalizeError(err)`

One consistent error shape regardless of source (fetch, axios, node http, generic):

```js
const { message, status, code, isNetworkError, isTimeout, isAborted } = normalizeError(err);
```

Understands Node's `TypeError: fetch failed` (real code read from `err.cause`), browser `Failed to fetch`, undici timeouts, and axios. `isTimeout` is only for real timeouts; a deliberate `AbortController.abort()` sets `isAborted` instead.

Every field is always present (`null`/`false` when not applicable) — no existence checks needed.

### `parseJsonSafe(input)`

Never throws on malformed JSON. Accepts a `Response` or a raw string.

```js
const { data, error } = await parseJsonSafe(response);
if (error) { /* handle malformed JSON without a try/catch */ }
```

### `buildQuery(params)`

Minimal query string builder — skips `null`/`undefined`, repeats the key for arrays, encodes everything.

```js
buildQuery({ q: "hello world", tag: ["a", "b"] });
// "q=hello%20world&tag=a&tag=b"
```

`Date` values are serialized as ISO 8601. Nested objects throw a `TypeError` (flatten or `JSON.stringify` them first) instead of silently becoming `[object Object]`.

For full parsing/nested-object support, use [`query-string`](https://www.npmjs.com/package/query-string) instead — this only covers the common flat-object case with zero dependencies.

### `retryAfterAware(fn, opts?)`

A ready-made preset over `withRetry`: retries a fetch-like call on 429/503, honoring `Retry-After`/`X-RateLimit-Reset` headers instead of blind backoff (no jitter; thrown network errors and timeouts are retried too). Use `withRetry` directly for jitter, budgets, or custom statuses.

```js
const response = await retryAfterAware(
  () => fetch(url),
  { retries: 3, retryStatusCodes: [429, 503] }
);
```

| Option | Default | Description |
|---|---|---|
| `retries` | `3` | |
| `retryStatusCodes` | `[429, 503]` | |
| `fallbackDelayMs` | `1000` | used when no usable header is present |
| `maxDelayMs` | `60000` | |
| `onRetry` | — | `(status, waitMs, attempt) => void` |
| `shouldRetryError` | network errors + timeouts | `(err, attempt) => boolean` — decides whether a *thrown* error is retried |
| `onRetryError` | — | `(err, waitMs, attempt) => void` |
| `signal` | — | `AbortSignal` — cancels the loop (even mid-wait), throwing `RetryAbortedError` |

The body of every response that gets retried is cancelled so the connection is freed.

### `withProgress(response, onProgress?, opts?)`

Reads a streamed `Response` body while reporting progress, returns the collected bytes as a `Uint8Array`.

```js
const bytes = await withProgress(response, ({ loaded, total, percent }) => {
  console.log(`${percent ?? "?"}% (${loaded}/${total ?? "?"} bytes)`);
});
```

Works without `Content-Length` too — `total`/`percent` are just `null` in that case, `loaded` is still accurate. They're also `null` when a `Content-Encoding` is applied (the header is the compressed size, but you receive decompressed bytes), and `percent` never exceeds 100. Falls back to a single-shot read (still calling `onProgress` once) if the response body is not a stream.

```js
const bytes = await withProgress(response, onProgress, {
  maxBytes: 50 * 1024 * 1024, // throws BodyTooLargeError (code "EBODYTOOLARGE") past this
  signal: controller.signal,  // abort the read
});
```

### `withDedupe(fn, opts?)`

Coalesces concurrent calls with the same arguments into a single in-flight call — every caller gets the same result, but the underlying request only fires once. Useful when several parts of a UI ask for the same resource around the same time.

```js
const getUser = withDedupe((id) => fetch(`/api/users/${id}`).then(r => r.json()));

const [a, b] = await Promise.all([getUser(1), getUser(1)]);
```

| Option | Default | Notes |
| --- | --- | --- |
| `keyFn` | `(...args) => JSON.stringify(args)` | derives the dedupe key from call args |

Plain arguments are compared by value (object key order doesn't matter); anything else — `AbortSignal`s, `Response`s, class instances, functions — is compared by identity, so calls with different `AbortSignal`s are never merged. Note that merged callers share one promise, so aborting the request affects everyone waiting on it.

This is deduplication of *concurrent* calls, not a cache — once a call settles (success or failure), the next call with the same key starts fresh.

```js
const fn = withDedupe((req) => doFetch(req), { keyFn: (req) => req.url });
```

---

### `createLimiter(concurrency)`

At most `concurrency` calls run at once; the rest wait in a FIFO queue.

```js
const limit = createLimiter(4);

const files = await limit.map(urls, (url) => download(url)); // results keep input order
// or one at a time:
const res = await limit(() => fetch(url));

limit.activeCount;  // running now
limit.pendingCount; // waiting
```

A task that throws or rejects only fails its own promise — the queue keeps going. `concurrency` must be an integer ≥ 1 (or `Infinity`).

### `createRateLimiter(opts?)`

A *proactive* limiter: it slows you down before the server has to say 429. It's fed by your own budget (`requests` per `perMs`, sliding window) **and** by what the server tells you — `X-RateLimit-Remaining` / `-Reset`, `RateLimit-*`, and `Retry-After` on 429/503. Once the server says `remaining: 0`, everything pauses until the reset. Callers are served FIFO.

```js
const rl = createRateLimiter({ requests: 10, perMs: 1000 });

const res = await rl.run(() => fetch(url)); // acquire → call → learn from the response headers
// or by hand:
await rl.acquire({ signal });  // rejects with the signal's reason if aborted while waiting
rl.update(response);
rl.blockedForMs;               // time left on a server-imposed pause
```

Reset headers are understood in both flavors: delta seconds (`30`) and absolute epoch (seconds or ms). In `createFetch`, waiting for the budget never counts against the per-attempt timeout.

### `createCircuitBreaker(opts?)`

After `failureThreshold` consecutive failures the circuit **opens** and calls fail instantly with `CircuitOpenError` for `resetTimeoutMs` — so a dying service isn't hammered and your callers don't sit waiting on it. Then it goes **half-open**, lets a probe through, and closes again on success.

```js
const breaker = createCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });

try {
  const res = await breaker.run(() => fetch(url));
} catch (err) {
  if (err instanceof CircuitOpenError) console.log(`try again in ${err.retryAfterMs}ms`);
}
breaker.state; // "closed" | "open" | "half-open"
```

By default a thrown error (except `AbortError`) or a result with `status >= 500` counts as a failure; override with `isFailure(valueOrError, isError)`. `CircuitOpenError` has `code: "CIRCUIT_OPEN"` and is never classified as a network error, so retries stop the moment the circuit opens.

### Streaming: `readSSE`, `readNDJSON`, `readLines`

Async iterators over a streamed body — a `Response`, a web `ReadableStream`, or any async iterable (Node streams). Early `break` and `signal` abort both cancel the stream so the connection is released.

```js
// LLM-style token stream (Server-Sent Events)
for await (const { event, data, id } of readSSE(response, { signal })) {
  if (data === "[DONE]") break;
  process.stdout.write(JSON.parse(data).token);
}

for await (const row of readNDJSON(response)) console.log(row); // newline-delimited JSON
for await (const line of readLines(response)) console.log(line);
```

All three take `{ signal, maxLineLength }` — a line (or one SSE event's data) longer than `maxLineLength` characters (default 16 Mi) throws `code: "LINE_TOO_LONG"` rather than buffering forever.

`readSSE` follows the spec: multi-line `data:` is joined with `\n`, comments are ignored, `event` defaults to `"message"`, `id` carries over, `retry` is parsed, and an event cut off by the end of the stream is dropped. `readNDJSON` skips blank lines and names the bad line on a parse error (or pass `skipInvalid: true`). Line splitting handles `\n`, `\r\n`, `\r`, a BOM, and multi-byte characters split across chunks.

### Pagination: `paginate`, `paginatePages`, `paginateLinks`

Walk any paginated API with a plain `for await` loop. Pages are fetched **lazily** — `break` out early (or set `maxItems`) and the pages you didn't need are never requested.

```js
import { paginate, paginateLinks } from "@boy-offi9-inc/reqkit";

// Cursor-based: you say how to fetch a page and what the next cursor is
for await (const user of paginate(async (cursor) => {
  const r = await api.json("/users", { query: { cursor, limit: 100 } });
  return { items: r.data, next: r.next_cursor };   // undefined/null on the last page
}, { maxItems: 500 })) {
  console.log(user.name);
}

// Offset-based is the same idea: the cursor is just a number
for await (const row of paginate(async (offset = 0) => {
  const rows = await api.json("/rows", { query: { offset, limit: 50 } });
  return { items: rows, next: rows.length === 50 ? offset + 50 : undefined };
})) { /* ... */ }

// GitHub-style `Link: <...>; rel="next"` headers — nothing to write
for await (const repo of paginateLinks(api, "/orgs/acme/repos?per_page=100")) {
  console.log(repo.full_name);
}
```

| API | What it does |
|---|---|
| `paginate(fetchPage, opts?)` | yields **items**; `opts`: `start`, `maxPages`, `maxItems`, `signal` |
| `paginatePages(fetchPage, opts?)` | yields **pages** `{ items, index, cursor }` |
| `paginateLinks(request, url, opts?)` | follows `Link` `rel="next"`; `request` is any fetch-like (a `createFetch` instance or plain `fetch` — a non-2xx page throws `HTTPError`); `getItems(data)` defaults to the body if it's an array, else `items` / `data` / `results` / `records` |
| `parseLinkHeader(header, base?)` | RFC 8288 `Link` parser → `{ next, prev, first, last, ... }`; handles commas in URLs and quoted params |

A `next` that equals the cursor just used (or a `Link` that points back at the same page) throws `code: "PAGINATE_STUCK"` instead of looping forever.

### Auto-reconnecting SSE: `streamSSE`

`readSSE` parses a stream you already have; **`streamSSE` opens it for you and keeps it open.** When the connection drops (or the server closes it) it reconnects by itself and sends `Last-Event-ID`, so the server can resume where you left off — what the browser's `EventSource` does, but built on `fetch`: custom headers, POST bodies, `AbortSignal`, your own client.

```js
import { streamSSE } from "@boy-offi9-inc/reqkit";

for await (const { id, data } of streamSSE("https://api.example.com/events", {
  headers: () => ({ authorization: `Bearer ${getToken()}` }), // re-evaluated on every reconnect
  onReconnect: ({ reason, delayMs, lastEventId }) => console.log(`reconnecting in ${delayMs}ms from id ${lastEventId}`),
  signal,
})) {
  handle(data);
}
```

| Behavior | Details |
|---|---|
| Resume | `Last-Event-ID` (the last `id:` seen) is sent on every reconnect; `lastEventId` option resumes on the first connect too |
| Delay | the server's `retry: <ms>` field sets the base delay (like `EventSource`); waits then back off exponentially up to `maxDelayMs` while connecting keeps failing; `Retry-After` on 429/503 is honored |
| Giving up | `retries` (default 10) counts consecutive attempts **without progress** — a connection that delivered an event resets it. Then it throws the last error |
| Stopping | HTTP `204` ends the stream (the standard "don't reconnect"); `stopWhen: e => e.data === "[DONE]"`; `break`ing out of the loop or aborting `signal` closes the connection |
| Fatal | a non-retryable status (401, 404…) throws `HTTPError` right away; a response that isn't `text/event-stream` throws (`code: "SSE_BAD_CONTENT_TYPE"`) |
| POST streams | **only GET reconnects by default** — re-sending a POST (say, an LLM prompt) could repeat side effects, so POST streams just end or throw unless you pass `reconnect: true` |

It takes any fetch: `streamSSE(url, { fetch: api })` with a `createFetch` instance works too.

### `downloadResumable(url, opts?)`

Downloads into memory and, if the connection drops mid-body, **resumes with an HTTP `Range` request** instead of starting over. It sends `If-Range` with the first response's strong ETag (or `Last-Modified`), so a file that changed on the server is restarted rather than stitched together wrongly; if the server ignores `Range`, it restarts from zero.

```js
const bytes = await downloadResumable(url, {
  onProgress: ({ loaded, total, percent }) => console.log(percent),
  maxBytes: 200 * 1024 * 1024, // BodyTooLargeError past this
  retries: 5,                  // consecutive attempts *without progress*
  signal,
  onRetry: (err, attempt, delayMs, { resumeFrom }) => console.log(`resuming from byte ${resumeFrom}`),
});
```

It honors `Retry-After` on 429/503, never retries a 4xx (other than 408/425/429) or a size-limit error, and asks for `Accept-Encoding: identity` so byte offsets line up. Pass `fetch: myCreateFetchInstance` to route it through your own client.

### `createMockFetch()`

A scriptable, fetch-compatible test double — for testing code with retries, timeouts, and rate limits without a network.

```js
const mock = createMockFetch();

mock.on("GET", "/users/1")
  .replyOnce(503, "busy", { headers: { "retry-after": "0" } })  // consumed in order…
  .reply(200, { id: 1 });                                        // …then this, forever
mock.post(/orders/).failOnce(mock.networkError("ECONNRESET"));   // reject like a real network failure
mock.get("/slow").reply(200, "late", { delayMs: 500 });          // respects AbortSignal → test timeouts

const api = createFetch({ fetch: mock.fetch, baseUrl: "https://api.test" });
await api.json("/users/1"); // { id: 1 } — after one retry
mock.calls;                 // [{ url, method, headers, body, json, signal }, ...]
mock.reset();
```

String matchers match the full URL, `pathname + search`, or the bare `pathname`; RegExp and `(url) => boolean` work too, and `"*"` matches any method. `replyWith(call => …)` returns a `Response` or `{ status, body, headers }`. Unmatched requests reject with a clear error (and are still recorded in `mock.calls`).

### `createFetch(defaults)`

Assembles the pieces above into one fetch-like function. It's still plain `fetch` underneath: you get a standard `Response` back, and you can supply your own `fetch`.

```js
import { createFetch, HTTPError } from "@boy-offi9-inc/reqkit";

const api = createFetch({
  baseUrl: "https://api.example.com/v1",
  headers: () => ({ authorization: `Bearer ${getToken()}` }), // object, or a function for changing tokens
  timeout: 10_000,            // per attempt
  retry: { retries: 3 },      // false to disable
  dedupe: true,               // merge identical concurrent GETs
});

const user = await api.json("/users/1", { query: { expand: ["team", "roles"] } });
const created = await api("/users", { method: "POST", json: { name: "Ada" } }); // Response

try {
  await api("/missing");
} catch (err) {
  if (err instanceof HTTPError) console.log(err.status, await err.response.json());
}

const admin = api.extend({ headers: { "x-role": "admin" } }); // merges over the parent
```

| Default / per-request option | Default | Description |
|---|---|---|
| `baseUrl` | — | joined onto relative URLs; absolute URLs are left alone |
| `headers` | — | object, `Headers`, or `() => headers` (sync or async) |
| `query` *(per request)* | — | object, serialized with `buildQuery` |
| `json` *(per request)* | — | serialized as the body, `content-type: application/json` set for you |
| `timeout` | `30000` | per attempt, in ms; `false` disables |
| `signal` *(per request)* | — | external abort; surfaces as a plain `AbortError`, never retried |
| `retry` | see below | `false` disables; otherwise `{ retries, statusCodes, methods, baseDelayMs, maxDelayMs, factor, jitter, maxRetryTime, shouldRetry, calculateDelay, onRetry }` |
| `rateLimit` | — | `true` just learns from `X-RateLimit-*` / `Retry-After`; `{ requests, perMs }` also enforces a budget; or pass a shared [`createRateLimiter`](#createratelimiteropts) |
| `circuitBreaker` | — | `true` / options → one breaker **per origin**; or pass a shared [`createCircuitBreaker`](#createcircuitbreakeropts), or `(url) => breaker`. An open circuit stops retries immediately. |
| `trustedOrigins` | — | extra origins that may receive the default credentials — see [Security](#security) |
| `auth` | — | attach a token and refresh it on 401 — see [Auth token refresh](#auth-token-refresh) |
| `cache` | — | in-memory GET cache — see [Caching](#caching). `true` = 60s TTL. Per request: `cache: false` bypasses, `"reload"` refreshes |
| `dedupe` | `false` | merge identical concurrent `GET`/`HEAD` calls; every caller gets its own readable clone. Requests with their own `signal` are never merged. |
| `throwHttpErrors` | `true` | throw `HTTPError` for non-2xx (`err.status`, `err.response`, `err.url`, `err.method`) |
| `fetch` | `globalThis.fetch` | swap in undici, node-fetch, a test double... |
| `onRequest(ctx)` | — | once per call; may mutate `ctx.url` / `ctx.init` (e.g. add a header) |
| `onResponse(ctx)` | — | once per call, with the final response, before `HTTPError` is thrown |

#### Auth token refresh

```js
let token = await loadToken();

const api = createFetch({
  baseUrl: "https://api.example.com",
  auth: {
    getToken: () => token,                                // attached as `Authorization: Bearer <token>`
    refresh: async () => { token = await loginAgain(); }, // called on 401 — ONCE, however many requests are waiting
  },
});

await Promise.all(urls.map((u) => api.json(u))); // 20 requests, all 401 → one refresh, all 20 replayed
```

- **Single-flight:** concurrent 401s share one `refresh()` call. A request rejected *after* someone else already refreshed notices the token changed and just replays with the new one — no second refresh.
- **Replay once:** if the replay is rejected too, you get the `401` (as `HTTPError`) — it never loops. Request bodies (JSON, strings…) are re-sent; a stream body can't be replayed, so its 401 is surfaced as is.
- **Your header wins:** if a request sets its own `Authorization`, reqkit leaves it alone and won't refresh it.
- **Options:** `header` (default `"authorization"`), `scheme` (default `"Bearer"`, `""` for a bare token such as an `X-API-Key`), `shouldRefresh(response)` (default: status 401). `refresh({ token, response })` may return the new token or just update your store. If `refresh` throws, every waiting request rejects with that error — and the next request tries again.
- `extend()` children that share the same `auth` object share one refresh; the cache keys entries per token.

#### Caching

```js
const api = createFetch({
  baseUrl: "https://api.example.com",
  cache: { ttl: 30_000, staleWhileRevalidate: 5 * 60_000 },
});

await api.json("/config"); // network
await api.json("/config"); // fresh → served from memory, no request
// after 30s: stale → returned instantly, refreshed in the background
// after 5m30s: revalidated with If-None-Match / If-Modified-Since — a 304 reuses the cached body
```

| `cache` option | Default | Description |
|---|---|---|
| `ttl` | `60000` | serve without asking the server for this long |
| `staleWhileRevalidate` | `0` | after the TTL, keep serving the stale copy this long while refreshing in the background |
| `maxEntries` | `100` | size of the built-in LRU store |
| `maxBodyBytes` | `1 MiB` | bigger responses aren't cached |
| `store` | built-in LRU | bring your own (`get`/`set`/`delete`, sync or async) — Redis, IndexedDB, a `Map`… |
| `onEvent` | — | `({ type: "hit" \| "stale" \| "revalidated" \| "miss" \| "store", url })` for logging/metrics |

Only `GET` `200` responses are cached; `Cache-Control: no-store` and `Vary: *` are respected. **Every request header is part of the cache key**, so a response fetched with one user's `Authorization` can never be served to another. Each hit is a fresh `Response`, so bodies can be read as many times as you like. `extend()` children share the parent's cache, limiter and breakers.

**Retry defaults:** 2 retries on network errors, timeouts, and status `408, 425, 429, 500, 502, 503, 504`, honoring `Retry-After`. Only **idempotent methods** (`GET, HEAD, OPTIONS, PUT, DELETE`) are retried — `POST`/`PATCH` aren't, so a timeout can't double-charge anyone. Opt a request in by sending an `Idempotency-Key` header, or by listing the method in `retry.methods`. Stream bodies are never retried (they can't be replayed).

---

## Prior art

reqkit's building blocks are small independent implementations of ideas from [`p-retry`](https://github.com/sindresorhus/p-retry), [`ky`](https://github.com/sindresorhus/ky), [`ofetch`](https://github.com/unjs/ofetch), [`got`](https://github.com/sindresorhus/got), [`axios-retry`](https://github.com/softonic/axios-retry), [`p-limit`](https://github.com/sindresorhus/p-limit), [`opossum`](https://github.com/nodeshift/opossum), [`bottleneck`](https://github.com/SGrondin/bottleneck), [`p-throttle`](https://github.com/sindresorhus/p-throttle), [`eventsource-parser`](https://github.com/rexxars/eventsource-parser) and [`nock`](https://github.com/nock/nock), plus the HTTP caching RFCs and the AWS "full jitter" backoff.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and the [architecture overview](./docs/architecture.md).

## License

[MIT](./LICENSE) © Boy Offi9
