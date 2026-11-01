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
  <img src="https://img.shields.io/badge/npm-%40boy--offi9--inc%2Freqkit-CB3837?logo=npm&logoColor=white" alt="npm package">
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/module-CJS%20%2B%20ESM-blue" alt="CJS + ESM">
  <img src="https://img.shields.io/badge/types-included-3178C6?logo=typescript&logoColor=white" alt="TypeScript types included">
</p>

# reqkit

**Tiny, zero-dependency HTTP helpers for `fetch`, axios, or anything else — retries that respect `Retry-After`, timeouts that really cancel, and errors that make sense.**

Not a client, not an axios replacement. Pull in the one function you need, or let [`createFetch`](#createfetchdefaults) wire them together for you — you always get a plain `Response` back.

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

---

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
| All of the above, wired up | [`createFetch`](#createfetchdefaults) |

---

## Why this exists

Most HTTP retry/timeout wrappers bundle everything into a client you have to fully adopt. This is the opposite: standalone functions that compose with whatever you're already using. Zero dependencies, CJS + ESM, TypeScript types included.

**Honest note:** retries, timeouts and error normalization are a well-covered problem — there are other solid packages doing similar things (`fetchy`, `fetchpilot`, `p-retry`, to name a few). What reqkit leans on:

- **It reads the server.** Retries wait for `Retry-After` / `X-RateLimit-Reset` instead of blind backoff on 429s — most retry libraries treat rate-limit responses like any other failure.
- **It's safe by default.** `createFetch` only retries idempotent methods, so a timed-out `POST` can't double-charge anyone.
- **It understands real-world errors.** Node's `TypeError: fetch failed` and the browser's `Failed to fetch` are classified as network errors, and a deliberate abort is never reported as a timeout.
- **It's not tied to a client.** `withProgress`, `withDedupe` and `createLimiter` work with any streamed body or async function.

---

## Install

```bash
npm install @boy-offi9-inc/reqkit
```

---

## API

### `withRetry(fn, opts?)`

Retries an async function with exponential backoff + jitter. Retries on thrown errors, and — opt in — on *results* (HTTP status codes or any predicate), waiting for `Retry-After` / `X-RateLimit-Reset` when the result has headers.

```js
const data = await withRetry(
  () => fetch(url).then(r => r.json()),
  { retries: 3, baseDelayMs: 300, onRetry: (err, attempt, delayMs) => console.log(`retry ${attempt} in ${delayMs}ms`) }
);

// fetch doesn't throw on 4xx/5xx — retry on statuses by returning the Response:
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
// Cancel a long retry/backoff sequence externally — e.g. the user navigated away
const controller = new AbortController();
const promise = withRetry(() => fetch(url), { retries: 5, signal: controller.signal });
controller.abort(); // rejects with RetryAbortedError, even mid-backoff
```

**Stop early with `StopRetry`** — throw it from inside `fn` when an error is not worth retrying (bad credentials, a 400...):

```js
const { withRetry, StopRetry } = require("@boy-offi9-inc/reqkit");

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

// Only one network request goes out — both callers share it.
const [a, b] = await Promise.all([getUser(1), getUser(1)]);
```

| Option | Default | Notes |
| --- | --- | --- |
| `keyFn` | `(...args) => JSON.stringify(args)` | derives the dedupe key from call args |

Plain arguments are compared by value (object key order doesn't matter); anything else — `AbortSignal`s, `Response`s, class instances, functions — is compared by identity, so calls with different `AbortSignal`s are never merged. Note that merged callers share one promise, so aborting the request affects everyone waiting on it.

This is deduplication of *concurrent* calls, not a cache — once a call settles (success or failure), the next call with the same key starts fresh.

```js
// Custom key when the default arg-based key isn't quite right
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

### `createFetch(defaults)`

Opt-in assembly of the pieces above into a fetch-like function. It's still plain `fetch` underneath: you get a standard `Response`, and you can pass your own `fetch`.

```js
const { createFetch } = require("@boy-offi9-inc/reqkit");

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
| `dedupe` | `false` | merge identical concurrent `GET`/`HEAD` calls; every caller gets its own readable clone. Requests with their own `signal` are never merged. |
| `throwHttpErrors` | `true` | throw `HTTPError` for non-2xx (`err.status`, `err.response`, `err.url`, `err.method`) |
| `fetch` | `globalThis.fetch` | swap in undici, node-fetch, a test double... |
| `onRequest(ctx)` | — | once per call; may mutate `ctx.url` / `ctx.init` (e.g. add a header) |
| `onResponse(ctx)` | — | once per call, with the final response, before `HTTPError` is thrown |

**Retry defaults:** 2 retries on network errors, timeouts, and status `408, 425, 429, 500, 502, 503, 504`, honoring `Retry-After`. Only **idempotent methods** (`GET, HEAD, OPTIONS, PUT, DELETE`) are retried — `POST`/`PATCH` aren't, so a timeout can't double-charge anyone. Opt a request in by sending an `Idempotency-Key` header, or by listing the method in `retry.methods`. Stream bodies are never retried (they can't be replayed).

---

## Design notes

- **Zero dependencies.** Nothing to audit, nothing to break underneath you.
- **CJS + ESM.** `require()` and `import` both work.
- **Composable, not a client.** Every function takes and returns plain values (`Response`, plain objects, `Uint8Array`) — nothing proprietary to learn.
- **TypeScript types included**, hand-written (no build step to go wrong), with separate entries for CJS and ESM.

---

## Prior art

reqkit's building blocks are small, from-scratch implementations of ideas that proved themselves in popular libraries — go look at them, they're great: [`p-retry`](https://github.com/sindresorhus/p-retry) (`StopRetry`, time budgets), [`ky`](https://github.com/sindresorhus/ky) and [`ofetch`](https://github.com/unjs/ofetch) (`HTTPError`, `json`/`query`/`baseUrl`, `extend`, retry statuses), [`got`](https://github.com/sindresorhus/got) and [`axios-retry`](https://github.com/softonic/axios-retry) (retry only idempotent methods, `calculateDelay`), [`p-limit`](https://github.com/sindresorhus/p-limit) (concurrency limiter), and the AWS Architecture Blog's "full jitter" backoff.
