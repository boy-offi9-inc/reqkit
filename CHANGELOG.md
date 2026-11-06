# Changelog

## 0.5.0

### Added
- **Interactive playground** (`docs/`): six live demos — `Retry-After` retries, rate limiter, circuit breaker, ETag cache, SSE streaming, resumable download — all against `createMockFetch`, no network. `pages.yml` publishes it to GitHub Pages.
- **Dependency-free ESM bundle**: `npm run build` writes `dist/reqkit.mjs` (and `docs/reqkit.mjs`) with a tiny hand-rolled module wrapper — no bundler dependency. Exposed as `@boy-offi9-inc/reqkit/browser` (types included) and shipped in the npm package for browsers, Deno, Bun and Cloudflare Workers. The build fails if anything in `src/` ever requires a non-relative module.
- **Multi-runtime CI**: Node 18/20/22/24 (tests + smoke + typecheck), plus smoke jobs on Deno, Bun and headless Chromium. The three non-Node jobs are `continue-on-error` until proven.
- **Runtime-agnostic smoke checks** (`smoke/`): 12 checks that run unchanged on Node, Deno, Bun and in a browser page.
- **`RECIPES.md`**: axios (retries with `Retry-After`, interceptors for the rate limiter, circuit breaker), ky, got, undici/node-fetch, Deno/Bun/Workers/browsers, testing with `createMockFetch`, and LLM streaming.
- Tests: bundle freshness + export parity, every playground demo and its outcome, and the page's DOM glue (via a DOM stub).

### Changed
- `prepublishOnly` builds the bundle, runs the tests and type-checks before every publish; the publish workflow builds first.
- `files` now includes `dist/` and `RECIPES.md`.

## 0.4.0

### Added
- **`createRateLimiter({ requests, perMs })`** — proactive limiter: a sliding-window budget *plus* server hints (`X-RateLimit-Remaining`/`-Reset`, `RateLimit-*`, `Retry-After`). Pauses everything once the server says `remaining: 0`. FIFO, abortable. `acquire()` / `update()` / `run()`.
- **`createCircuitBreaker(opts)`** + `CircuitOpenError` — closed → open → half-open breaker with `failureThreshold`, `resetTimeoutMs`, `halfOpenMax`, `isFailure`, `onStateChange`.
- **`createFetch` options:** `rateLimit` (budget and/or learn from headers; waiting never counts against the attempt timeout), `circuitBreaker` (per-origin by default; an open circuit stops retries instantly), and `cache` — in-memory GET cache with `ttl`, `staleWhileRevalidate`, ETag/Last-Modified revalidation (304 → cached body), `maxBodyBytes`, pluggable `store`, `onEvent`, and per-request `cache: false | "reload"`. The cache key includes every request header, so per-user responses never leak. `extend()` children share the parent's limiter, breakers and cache.
- **`createMemoryCache({ maxEntries })`** — the LRU store behind `cache`.
- **`downloadResumable(url, opts)`** — resumes interrupted downloads with `Range` + `If-Range` (restarts if the file changed or the server ignores Range); `onProgress`, `maxBytes`, `signal`, retries counted per attempts *without progress*, `Retry-After` honored.
- **`readSSE`, `readNDJSON`, `readLines`** — async iterators over a Response / ReadableStream / Node stream; spec-compliant SSE; stream is cancelled on early `break` or abort.
- **`createMockFetch()`** — scriptable fetch test double: `on/get/post/...`, `reply`, `replyOnce`, `replyWith`, `fail`, `failOnce`, `networkError()`, `delayMs` (abort-aware), recorded `calls`.
- `HTTPError` now lives in its own module (still exported from the package root).

### Fixed
- `X-RateLimit-Reset` given as **delta seconds** (e.g. `30`) was read as an epoch and produced a zero wait. Values under ~31 years in seconds are now treated as deltas; epoch seconds/ms still work. Also understands `X-RateLimit-Reset-After` and `RateLimit-Reset`.

## 0.3.0

### Added
- **`withRetry` is now the one retry primitive.** Besides thrown errors it can retry on *results*: `retryStatusCodes`, `shouldRetryResult`, with `Retry-After` / `X-RateLimit-Reset` honored (`respectRetryAfter`, `maxRetryAfterMs`). New options: `factor`, `jitter` (number or `"full"`), `maxRetryTime` (total time budget), `calculateDelay` (custom wait, or `false` to stop). `onRetry` gets a 4th `ctx` argument (`{ reason, result, status }`).
- **`StopRetry`** — throw it from inside `fn` to stop retrying immediately.
- **`createLimiter(concurrency)`** — concurrency limiter with `activeCount`, `pendingCount` and `map()`.
- **`createFetch(defaults)`** + **`HTTPError`** — opt-in fetch assembly: `baseUrl`, `query`, `json`, dynamic headers, per-attempt timeout, idempotency-aware retries (`GET/HEAD/OPTIONS/PUT/DELETE` by default, `Idempotency-Key` opt-in) with `Retry-After`, concurrent-GET dedupe with per-caller response clones, `onRequest`/`onResponse` hooks, `.json()` and `.extend()`.
- `withTimeout(fn, ms, { signal })` — link an external `AbortSignal`; `ms: Infinity` disables the timer; invalid `ms` throws a `TypeError`.

### Changed
- `retryAfterAware` is now a thin preset over `withRetry` (same options and behavior as 0.2.0).
- `withTimeout` aborts the signal it hands to `fn` with a `TimeoutError` reason; the error it throws is unchanged.
- Internal: shared header parsing / body discarding moved to `src/_http.js`; the abortable sleep lives in `src/_sleep.js`.

## 0.2.0

### Fixed
- **`normalizeError`** now classifies `TypeError: fetch failed` (Node/undici) and `Failed to fetch` (browsers) as network errors, reading the real code (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_*`, ...) from `err.cause` / `AggregateError`. Undici timeouts are reported as timeouts. `ERR_*` programming errors are no longer treated as network errors, while DNS codes like `EAI_AGAIN` now are.
- **`normalizeError`** no longer reports a plain user abort as a timeout. `AbortError` → `isAborted: true`, `isTimeout: false`, `code: "ABORT_ERR"`. Real timeouts (`TimeoutError`, `AbortSignal.timeout()`, `ETIMEDOUT`) still set `isTimeout`.
- **`withDedupe`** no longer merges calls that carry different `AbortSignal`s (or other non-plain objects): `JSON.stringify` turned them all into `{}`. Non-plain values are keyed by identity, plain-object key order no longer matters, and bigint / circular arguments are handled.
- **`withProgress`** no longer reports `percent > 100`. `total`/`percent` are `null` when a `Content-Encoding` is applied (Content-Length is the compressed size), garbage Content-Length values are ignored, and percent is clamped to 100.
- **`retryAfterAware`** cancels the body of each response it retries so connections are released, and `parseRetryAfter("")` / whitespace now returns `null` instead of `0`.
- **`buildQuery`** serializes `Date` as ISO 8601 and throws a `TypeError` for nested objects instead of emitting `[object Object]`.
- Package: added `repository`, `homepage` and `bugs`; ESM consumers now get their own `index.d.mts` (fixes "masquerading as CJS" errors under `node16`/`nodenext`).

### Added
- `retryAfterAware`: `signal`, `shouldRetryError` and `onRetryError` options. Thrown network errors and timeouts are now retried by default (pass `shouldRetryError: () => false` for the old behavior).
- `withProgress(response, onProgress, { maxBytes, signal })` and the exported `BodyTooLargeError`.
- `normalizeError` returns a new `isAborted` field.
- `RetryAbortedError` carries the last failure as `cause`.
- CI (Node 18/20/22 + type tests) and a provenance-enabled publish workflow.

### Changed (behavior)
- `buildQuery` throws on nested objects / invalid Dates (previously produced garbage).
- `normalizeError(AbortError).isTimeout` is now `false`.
