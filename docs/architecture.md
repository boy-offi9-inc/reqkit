# Architecture

reqkit is a set of small, independent functions with no runtime dependencies. It's written in CommonJS and uses only web-standard APIs (`fetch`, `Response`, `Headers`, `AbortSignal`, `ReadableStream`), so the same code runs on Node 18+, Deno, Bun, Cloudflare Workers and browsers.

## Layout

```
src/
  index.js, index.mjs   public entry points (the ESM one re-exports the CJS one)
  internal/             private helpers, never exported
  errors/               HTTPError, normalizeError
  resilience/           retry, timeout, hedge, dedupe, limiter, rate limiter, circuit breaker
  http/                 createFetch, buildQuery, parseJsonSafe, response cache
  streams/              line/NDJSON/SSE readers, streamSSE, progress, resumable downloads
  pagination/           paginate, paginateLinks, parseLinkHeader
  testing/              createMockFetch
types/                  hand-written .d.ts, one file per layer
test/                   mirrors src/
playground/             the interactive demo
smoke/                  runtime-agnostic checks (Node, Deno, Bun, Chromium)
scripts/build-esm.js    builds the dependency-free ESM bundle
```

## Layers

A layer may only require itself and the layers listed here. `test/package/architecture.test.js` enforces it, along with no cycles, no runtime dependencies, no unreachable modules, and `types/` and `test/` mirroring the layers.

| Layer | May depend on |
|---|---|
| `internal` | — |
| `errors` | internal |
| `resilience` | internal, errors |
| `http` | internal, errors, resilience |
| `streams` | internal, errors |
| `pagination` | internal, errors |
| `testing` | internal |

`src/index.js` is the only file that imports from every layer.

## Conventions

- **Plain values in, plain values out.** Functions take and return functions, `Response`s and plain objects.
- **Errors live next to the feature that throws them** and are re-exported from `src/index.js`. Their `code`s never look like Node network codes (`E` + capitals), so `normalizeError` can't mistake them for one.
- **Abort is first-class.** Anything that waits accepts a `signal` and rejects with `signal.reason`.
- **Server data is untrusted.** Parsers are linear-time and bounded; credentials never leave trusted origins.
- **Types are hand-written** and checked against both the ESM and CJS entry points.

## How a `createFetch` request flows

```
request(url, init)
 ├─ join baseUrl + query; decide whether this origin may receive default credentials
 ├─ merge default headers + JSON body + onRequest hook
 ├─ auth: attach the token
 ├─ cache lookup: fresh hit, or stale-while-revalidate
 └─ network
     └─ retry, per attempt
         └─ circuit breaker
             └─ rate limiter (acquire) → timeout → dedupe → fetch → rate limiter (learn from headers)
 ├─ 401: refresh the token once, then replay
 ├─ 304: reuse the cached body; 200: store it
 └─ onResponse hook; throw HTTPError if the response isn't ok
```

## The ESM bundle

`scripts/build-esm.js` wraps every file in `src/` in a function and adds a small relative-path `require`, producing one dependency-free file: `dist/reqkit.mjs`, published as `@boy-offi9-inc/reqkit/browser`. It refuses to bundle a non-relative `require`. A copy in `playground/` powers the demo, and a test fails if that copy is stale (`npm run build` refreshes it).

## Adding a feature

1. Put it in the layer it belongs to.
2. Export it from both `src/index.js` and `src/index.mjs`.
3. Add its types to that layer's file in `types/`, and exercise them in `typecheck/`.
4. Add tests under the mirrored `test/<layer>/`, preferring real local servers (`test/helpers/server.js`) or `createMockFetch` over stubs.
5. Document it in the README.
