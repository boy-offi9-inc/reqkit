<p align="center">
  <a href="https://www.npmjs.com/package/@boy-offi9-inc/reqkit" aria-label="npm">
    <img src="https://i.ibb.co/1f63mDTg/logo-wordmark.png" alt="reqkit on npm" width="480" />
  </a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node >=18">
  <img src="https://img.shields.io/badge/npm-%40boy--offi9--inc%2Freqkit-CB3837?logo=npm&logoColor=white" alt="npm package">
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/module-CJS%20%2B%20ESM-blue" alt="CJS + ESM">
  <img src="https://img.shields.io/badge/types-included-3178C6?logo=typescript&logoColor=white" alt="TypeScript types included">
</p>

# reqkit

Small, composable HTTP helper functions. Not a client, not an axios replacement — works alongside `fetch`, `axios`, or anything else you're already using. Pull in the one function you need; ignore the rest.

```js
const { withRetry, normalizeError } = require("@boy-offi9-inc/reqkit");

const data = await withRetry(() => fetch(url).then(r => r.json()));
```

---

## Why this exists

Most HTTP retry/timeout wrappers bundle everything into a client you have to fully adopt. This is the opposite: standalone functions that compose with whatever you're already using, and a couple of small helpers that you can pick up independently.

**Honest note:** `withRetry`, `withTimeout`, and `normalizeError` solve a well-covered problem — there are other solid packages doing similar things (`fetchy`, `fetchpilot`, `p-retry`, to name a few).

- **`retryAfterAware`** — actually reads `Retry-After`/`X-RateLimit-Reset` headers instead of blind backoff on 429s. Most retry libraries treat rate-limit responses like any other failure and ignore the server's suggested retry time.
- **`withProgress`** — progress callback for any streamed response body (downloads, large payloads, anything), not tied to a specific HTTP client.
- **`withDedupe`** — coalesces concurrent calls with the same key into one in-flight call, so simultaneous requests for the same resource don't each hit the network.

Zero dependencies. CJS + ESM. TypeScript types included.

---

## Install

```bash
npm install @boy-offi9-inc/reqkit
```

---

## API

### `withRetry(fn, opts?)`

Retries an async function with exponential backoff + jitter.

```js
const data = await withRetry(
  () => fetch(url).then(r => r.json()),
  { retries: 3, baseDelayMs: 300, onRetry: (err, attempt, delayMs) => console.log(`retry ${attempt} in ${delayMs}ms`) }
);
```

| Option | Default | Description |
|---|---|---|
| `retries` | `3` | max retry attempts after the first try |
| `baseDelayMs` | `300` | initial delay |
| `maxDelayMs` | `10000` | delay ceiling |
| `shouldRetry` | retries anything but AbortError | `(err, attempt) => boolean` |
| `onRetry` | — | `(err, attempt, delayMs) => void` |
| `signal` | — | `AbortSignal` — cancels the whole retry loop, including any pending backoff wait, throwing `RetryAbortedError` |

```js
// Cancel a long retry/backoff sequence externally — e.g. the user navigated away
const controller = new AbortController();
const promise = withRetry(() => fetch(url), { retries: 5, signal: controller.signal });
controller.abort(); // rejects with RetryAbortedError, even mid-backoff
```

### `withTimeout(fn, ms)`

Races an async function against a timeout, passing it an `AbortSignal` so the underlying request can actually be cancelled.

```js
const data = await withTimeout(
  signal => fetch(url, { signal }).then(r => r.json()),
  5000
);
// throws TimeoutError on timeout, regardless of whether fn cooperates with the signal
```

### `normalizeError(err)`

One consistent error shape regardless of source (fetch, axios, node http, generic):

```js
const { message, status, code, isNetworkError, isTimeout } = normalizeError(err);
```

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

For full parsing/nested-object support, use [`query-string`](https://www.npmjs.com/package/query-string) instead — this only covers the common flat-object case with zero dependencies.

### `retryAfterAware(fn, opts?)`

Retries a fetch-like call, honoring `Retry-After`/`X-RateLimit-Reset` headers on 429/503 instead of blind backoff.

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

### `withProgress(response, onProgress?)`

Reads a streamed `Response` body while reporting progress, returns the collected bytes as a `Uint8Array`.

```js
const bytes = await withProgress(response, ({ loaded, total, percent }) => {
  console.log(`${percent ?? "?"}% (${loaded}/${total ?? "?"} bytes)`);
});
```

Works without `Content-Length` too — `total`/`percent` are just `null` in that case, `loaded` is still accurate. Falls back to a single-shot read (still calling `onProgress` once) if the response body is not a stream.

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

This is deduplication of *concurrent* calls, not a cache — once a call settles (success or failure), the next call with the same key starts fresh.

```js
// Custom key when the default arg-based key isn't quite right
const fn = withDedupe((req) => doFetch(req), { keyFn: (req) => req.url });
```

---

## Design notes

- **Zero dependencies.** Nothing to audit, nothing to break underneath you.
- **CJS + ESM.** `require()` and `import` both work.
- **Composable, not a client.** Every function takes and returns plain values (`Response`, plain objects, `Uint8Array`) — nothing proprietary to learn.
- **TypeScript types included**, hand-written (no build step to go wrong).
