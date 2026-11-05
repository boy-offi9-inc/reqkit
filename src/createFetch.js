const { withRetry, RetryAbortedError } = require("./withRetry");
const { withTimeout } = require("./withTimeout");
const { withDedupe } = require("./withDedupe");
const { buildQuery } = require("./buildQuery");
const { parseJsonSafe } = require("./parseJsonSafe");
const { normalizeError } = require("./normalizeError");
const { HTTPError } = require("./HTTPError");
const { createRateLimiter } = require("./createRateLimiter");
const { createCircuitBreaker } = require("./createCircuitBreaker");
const { createMemoryCache } = require("./createMemoryCache");
const { cacheKey, snapshotResponse, entryToResponse } = require("./_cache");
const { discardBody, getOrigin } = require("./_http");

const DEFAULT_RETRY_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504];
// Safe to repeat without side effects. POST/PATCH are deliberately absent.
const DEFAULT_RETRY_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];
// Default headers that carry credentials. They're only sent to trusted origins.
const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key", "x-auth-token"];

function isAbsoluteUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

function joinUrl(baseUrl, url, query) {
  let full = String(url);
  if (baseUrl && !isAbsoluteUrl(full)) {
    full = `${String(baseUrl).replace(/\/+$/, "")}/${full.replace(/^\/+/, "")}`;
  }
  const qs = query ? buildQuery(query) : "";
  if (qs) full += (full.includes("?") ? "&" : "?") + qs;
  return full;
}

async function resolveHeaders(source) {
  const value = typeof source === "function" ? await source() : source;
  return new Headers(value || undefined);
}

function mergeHeaders(...headerSets) {
  const out = new Headers();
  for (const set of headerSets) {
    set.forEach((value, key) => out.set(key, value));
  }
  return out;
}

function isStreamBody(body) {
  return Boolean(body) && typeof body === "object" && typeof body.getReader === "function";
}

function originOf(url) {
  return getOrigin(url) || url;
}

// One in-flight token refresh per `auth` config object, so concurrent 401s —
// even across extend() children — trigger exactly one refresh.
const refreshStates = new WeakMap();
function refreshStateFor(auth) {
  let state = refreshStates.get(auth);
  if (!state) {
    state = { inflight: null };
    refreshStates.set(auth, state);
  }
  return state;
}

function mergeDefaults(base, extra) {
  const merged = { ...base, ...extra };

  if (base.headers || extra.headers) {
    merged.headers = async () => {
      const a = await resolveHeaders(base.headers);
      const b = await resolveHeaders(extra.headers);
      return mergeHeaders(a, b);
    };
  }
  if (base.retry !== false && extra.retry !== false && (base.retry || extra.retry)) {
    merged.retry = { ...base.retry, ...extra.retry };
  }
  return merged;
}

/**
 * Builds a fetch-like function from the other reqkit pieces — only if you
 * want that. It's still plain `fetch` underneath: you get a standard
 * `Response` back, and `fetch` itself stays swappable.
 *
 * What you get on top of fetch:
 *  - `baseUrl`, `query` (via buildQuery), `json` request bodies
 *  - default headers (an object, or a function for tokens that change)
 *  - per-attempt `timeout` (withTimeout) and external `signal`
 *  - retries (withRetry) on network errors/timeouts and retryable statuses,
 *    honoring Retry-After; only for idempotent methods unless you opt in
 *  - `rateLimit`: stay under a budget and obey X-RateLimit-* / Retry-After
 *    *before* the server has to say 429
 *  - `circuitBreaker`: fail fast against a service that keeps failing
 *  - `cache`: in-memory GET cache with TTL, stale-while-revalidate and
 *    ETag / Last-Modified revalidation (304s)
 *  - concurrent GET de-duplication (withDedupe)
 *  - `auth`: attach a token, and on a 401 refresh it ONCE (shared by all
 *    concurrent requests) and replay the request
 *  - credential safety: default credentials (`auth`, and default headers like
 *    Authorization/Cookie/X-API-Key) are only sent to `baseUrl`'s origin and
 *    `trustedOrigins` — pass an absolute URL to another host and they stay home
 *  - `HTTPError` on non-2xx (turn off with `throwHttpErrors: false`)
 *  - `onRequest` / `onResponse` hooks
 *
 * @param {object} [defaults]
 * @param {string} [defaults.baseUrl]
 * @param {HeadersInit | (() => HeadersInit | Promise<HeadersInit>)} [defaults.headers]
 * @param {number | false} [defaults.timeout=30000] - per attempt, ms
 * @param {false | object} [defaults.retry] - false disables. Options:
 *   `retries`(2), `statusCodes`, `methods`, `baseDelayMs`, `maxDelayMs`,
 *   `factor`, `jitter`, `maxRetryTime`, `onRetry`, `calculateDelay`
 * @param {boolean | object} [defaults.rateLimit] - `true` just learns from
 *   response headers; `{ requests, perMs }` also enforces a budget; or pass a
 *   createRateLimiter() instance to share one budget
 * @param {boolean | object | Function} [defaults.circuitBreaker] - options for
 *   a per-origin breaker, a createCircuitBreaker() instance, or `(url) => breaker`
 * @param {boolean | object} [defaults.cache] - `{ ttl, staleWhileRevalidate,
 *   maxEntries, maxBodyBytes, store, onEvent }`; `true` = 60s TTL
 * @param {object} [defaults.auth] - `{ getToken, refresh, header?, scheme?, shouldRefresh? }`.
 *   `getToken()` supplies the current token (sync or async); on a 401 (or
 *   whatever `shouldRefresh(response)` says) `refresh({ token, response })` is
 *   called once for all concurrent callers and the request is replayed with the
 *   new token. `header` defaults to "authorization", `scheme` to "Bearer" ("" for none).
 * @param {string[]} [defaults.trustedOrigins] - extra origins ("https://cdn.example.com") that may
 *   receive the default credentials, besides `baseUrl`'s. With neither `baseUrl` nor
 *   `trustedOrigins` set there is nothing to compare against and credentials go everywhere.
 * @param {boolean} [defaults.dedupe=false] - merge identical concurrent GET/HEAD calls
 * @param {boolean} [defaults.throwHttpErrors=true]
 * @param {typeof fetch} [defaults.fetch=globalThis.fetch]
 * @param {(ctx: {url: string, init: object}) => void | Promise<void>} [defaults.onRequest] -
 *   runs once per call; may mutate ctx.url / ctx.init (e.g. add a header)
 * @param {(ctx: {url: string, init: object, response: Response}) => void | Promise<void>} [defaults.onResponse]
 */
function createFetch(defaults = {}) {
  const {
    baseUrl,
    headers: defaultHeaders,
    timeout: defaultTimeout = 30000,
    retry: defaultRetry = {},
    rateLimit,
    circuitBreaker,
    cache,
    auth,
    trustedOrigins,
    dedupe = false,
    throwHttpErrors: defaultThrow = true,
    fetch: customFetch,
    onRequest,
    onResponse,
  } = defaults;

  const doFetch = (...args) => (customFetch || globalThis.fetch)(...args);

  // Origins allowed to receive default credentials. Empty = no baseUrl to compare against = unrestricted.
  const trusted = new Set();
  for (const o of [baseUrl, ...(trustedOrigins || [])]) {
    const origin = o && getOrigin(o);
    if (origin) trusted.add(origin);
  }
  const isTrustedTarget = (url) => {
    if (trusted.size === 0 || !isAbsoluteUrl(url)) return true; // relative URLs resolve against our own base
    const origin = getOrigin(url);
    return origin !== null && trusted.has(origin);
  };

  // --- stateful pieces, built once so `extend()` children share them -------
  const limiter = !rateLimit
    ? null
    : typeof rateLimit.acquire === "function"
      ? rateLimit
      : createRateLimiter(rateLimit === true ? {} : rateLimit);

  const breakerRegistry = new Map();
  const breakerFor = !circuitBreaker
    ? null
    : typeof circuitBreaker === "function"
      ? circuitBreaker
      : typeof circuitBreaker.run === "function"
        ? () => circuitBreaker
        : (url) => {
            const origin = originOf(url);
            if (!breakerRegistry.has(origin)) {
              breakerRegistry.set(origin, createCircuitBreaker(circuitBreaker === true ? {} : circuitBreaker));
            }
            return breakerRegistry.get(origin);
          };

  const cacheCfg = !cache
    ? null
    : {
        ttl: 60000,
        staleWhileRevalidate: 0,
        maxEntries: 100,
        maxBodyBytes: undefined,
        ...(cache === true ? {} : cache),
      };
  if (cacheCfg && !cacheCfg.store) cacheCfg.store = createMemoryCache({ maxEntries: cacheCfg.maxEntries });
  // In-flight bookkeeping lives on the (shared) cache config so `extend()`
  // children see the parent's pending writes and revalidations.
  if (cacheCfg) {
    cacheCfg.pending = cacheCfg.pending || new Map();
    cacheCfg.revalidating = cacheCfg.revalidating || new Set();
  }
  const pendingStores = cacheCfg ? cacheCfg.pending : null;
  const revalidating = cacheCfg ? cacheCfg.revalidating : null;
  const emit = (type, url) => cacheCfg && cacheCfg.onEvent && cacheCfg.onEvent({ type, url });

  // Shared in-flight GETs. Every caller gets its own clone of the response so
  // body reads don't fight each other.
  const sharedFetch = withDedupe((key, url, init) => doFetch(url, init), { keyFn: (key) => key });

  function scheduleStore(key, response, url) {
    const p = snapshotResponse(response, cacheCfg.maxBodyBytes)
      .then(async (entry) => {
        if (entry) {
          await cacheCfg.store.set(key, entry);
          emit("store", url);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (pendingStores.get(key) === p) pendingStores.delete(key);
      });
    pendingStores.set(key, p);
  }

  // Returns a token newer than `usedToken`, refreshing at most once no matter
  // how many requests were rejected at the same time. If someone else already
  // refreshed (the current token isn't the one we used), just use that.
  async function obtainFreshToken(authCfg, tokenUsed, response) {
    const current = await authCfg.getToken();
    if (current && current !== tokenUsed) return current;

    const state = refreshStateFor(authCfg);
    if (!state.inflight) {
      state.inflight = (async () => {
        try {
          const out = await authCfg.refresh({ token: tokenUsed, response });
          return typeof out === "string" && out ? out : await authCfg.getToken();
        } finally {
          state.inflight = null;
        }
      })();
    }
    return state.inflight;
  }

  async function request(input, init = {}) {
    const {
      query,
      json,
      timeout = defaultTimeout,
      retry: retryOpt,
      throwHttpErrors = defaultThrow,
      signal,
      headers: initHeaders,
      cache: cacheMode,
      ...fetchInit
    } = init;

    const method = String(fetchInit.method || "GET").toUpperCase();
    const url = joinUrl(baseUrl, input, query);
    const credentialsAllowed = isTrustedTarget(url);

    const defaultHeaderSet = await resolveHeaders(defaultHeaders);
    if (!credentialsAllowed) {
      // An absolute URL to some other host: don't hand it our default credentials.
      for (const name of [...SENSITIVE_HEADERS, ...(auth && auth.header ? [String(auth.header).toLowerCase()] : [])]) {
        defaultHeaderSet.delete(name);
      }
    }
    // Headers the caller passes for *this* call are deliberate, so they always go through.
    const headers = mergeHeaders(defaultHeaderSet, new Headers(initHeaders || undefined));

    let body = fetchInit.body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }

    const ctx = { url, init: { ...fetchInit, method, headers, body } };
    if (onRequest) await onRequest(ctx);
    const finalHeaders = ctx.init.headers instanceof Headers ? ctx.init.headers : new Headers(ctx.init.headers);
    const finalMethod = String(ctx.init.method || method).toUpperCase();

    // --- auth: attach the current token (unless the caller set the header) ----
    const authHeader = auth ? String(auth.header || "authorization").toLowerCase() : null;
    const formatToken = (token) => (auth.scheme === "" ? String(token) : `${auth.scheme === undefined ? "Bearer" : auth.scheme} ${token}`);
    let usedToken = null;
    if (auth && credentialsAllowed && !finalHeaders.has(authHeader)) {
      usedToken = (await auth.getToken()) || null;
      if (usedToken) finalHeaders.set(authHeader, formatToken(usedToken));
    }

    // --- retry policy ------------------------------------------------------
    const retryCfg = retryOpt === false || defaultRetry === false ? false : { ...defaultRetry, ...retryOpt };
    const methods = (retryCfg && retryCfg.methods) || DEFAULT_RETRY_METHODS;
    const hasIdempotencyKey = finalHeaders.has("idempotency-key");
    const canRetry =
      retryCfg !== false &&
      !isStreamBody(ctx.init.body) && // a consumed stream can't be replayed
      (methods.map((m) => m.toUpperCase()).includes(finalMethod) || hasIdempotencyKey);
    const { statusCodes, methods: _methods, retries = 2, shouldRetry: customShouldRetry, ...retryRest } = retryCfg || {};

    // One trip to the network: rate limit → circuit breaker → per-attempt
    // timeout → fetch, retried per the policy above. `netHeaders` and
    // `netSignal` are parameters so background revalidation can reuse this.
    function network(netHeaders, netSignal) {
      const attemptOnce = () => {
        const attempt = async () => {
          if (limiter) await limiter.acquire({ signal: netSignal });
          const res = await withTimeout(
            (attemptSignal) => {
              const attemptInit = { ...ctx.init, method: finalMethod, headers: netHeaders, signal: attemptSignal };
              const useDedupe =
                dedupe && !netSignal && !ctx.init.body && (finalMethod === "GET" || finalMethod === "HEAD");
              if (!useDedupe) return doFetch(ctx.url, attemptInit);
              // No per-attempt signal on a shared request: aborting one caller
              // must never cancel everyone else's. It still gets its own
              // timeout so a hung server can't leak the request.
              const sharedInit = {
                ...attemptInit,
                signal: timeout === false ? undefined : AbortSignal.timeout(timeout),
              };
              const key = `${finalMethod} ${ctx.url} ${JSON.stringify([...netHeaders.entries()].sort())}`;
              return sharedFetch(key, ctx.url, sharedInit).then((res) => res.clone());
            },
            timeout === false ? Infinity : timeout,
            { signal: netSignal }
          );
          if (limiter) limiter.update(res);
          return res;
        };
        const breaker = breakerFor && breakerFor(ctx.url);
        return breaker ? breaker.run(attempt) : attempt();
      };

      return canRetry
        ? withRetry(attemptOnce, {
            ...retryRest,
            retries,
            retryStatusCodes: statusCodes || DEFAULT_RETRY_STATUS_CODES,
            shouldRetry:
              customShouldRetry ||
              ((err) => {
                const n = normalizeError(err);
                return n.isNetworkError || n.isTimeout;
              }),
            signal: netSignal,
          })
        : attemptOnce();
    }

    function conditionalHeaders(entry) {
      const h = new Headers(finalHeaders);
      if (entry) {
        if (entry.etag && !h.has("if-none-match")) h.set("if-none-match", entry.etag);
        if (entry.lastModified && !h.has("if-modified-since")) h.set("if-modified-since", entry.lastModified);
      }
      return h;
    }

    // --- cache lookup --------------------------------------------------------
    const useCache =
      Boolean(cacheCfg) &&
      finalMethod === "GET" &&
      !ctx.init.body &&
      cacheMode !== false &&
      cacheMode !== "no-store";
    let key = useCache ? cacheKey(finalMethod, ctx.url, finalHeaders) : null;
    let entry = null;

    const finish = async (response) => {
      if (onResponse) await onResponse({ url: ctx.url, init: ctx.init, response });
      if (throwHttpErrors && !response.ok) {
        throw new HTTPError(response, { method: finalMethod, url: ctx.url });
      }
      return response;
    };

    if (useCache && cacheMode !== "reload") {
      if (pendingStores.has(key)) await pendingStores.get(key);
      entry = (await cacheCfg.store.get(key)) || null;
      if (entry) {
        const age = Date.now() - entry.storedAt;
        if (age < cacheCfg.ttl) {
          emit("hit", ctx.url);
          return finish(entryToResponse(entry));
        }
        if (age < cacheCfg.ttl + cacheCfg.staleWhileRevalidate) {
          emit("stale", ctx.url);
          if (!revalidating.has(key)) {
            revalidating.add(key);
            const staleEntry = entry;
            (async () => {
              try {
                const res = await network(conditionalHeaders(staleEntry), undefined);
                if (res.status === 304) {
                  staleEntry.storedAt = Date.now();
                  await cacheCfg.store.set(key, staleEntry);
                  emit("revalidated", ctx.url);
                  await discardBody(res);
                } else if (res.status === 200) {
                  scheduleStore(key, res, ctx.url);
                  await pendingStores.get(key);
                } else {
                  await discardBody(res);
                }
              } catch {
                // keep serving the stale copy; try again next time
              } finally {
                revalidating.delete(key);
              }
            })();
          }
          return finish(entryToResponse(entry));
        }
      }
    }

    // --- network -------------------------------------------------------------
    let response;
    try {
      response = await network(useCache ? conditionalHeaders(entry) : finalHeaders, signal);
    } catch (err) {
      // Present a user abort as the plain AbortError they caused, not as retry internals.
      if (err instanceof RetryAbortedError && signal && signal.aborted) throw signal.reason ?? err;
      throw err;
    }

    // --- auth: a rejected token is refreshed once, then the request replays ----
    const needsRefresh = auth && (auth.shouldRefresh ? auth.shouldRefresh(response) : response.status === 401);
    if (usedToken && needsRefresh && !isStreamBody(ctx.init.body)) {
      const fresh = await obtainFreshToken(auth, usedToken, response);
      if (fresh) {
        await discardBody(response);
        finalHeaders.set(authHeader, formatToken(fresh));
        entry = null; // belongs to the old token's cache key
        if (useCache) key = cacheKey(finalMethod, ctx.url, finalHeaders);
        try {
          response = await network(finalHeaders, signal);
        } catch (err) {
          if (err instanceof RetryAbortedError && signal && signal.aborted) throw signal.reason ?? err;
          throw err;
        }
      }
    }

    if (useCache) {
      if (response.status === 304 && entry) {
        entry.storedAt = Date.now();
        await cacheCfg.store.set(key, entry);
        emit("revalidated", ctx.url);
        await discardBody(response);
        response = entryToResponse(entry);
      } else {
        emit("miss", ctx.url);
        if (response.status === 200) scheduleStore(key, response, ctx.url);
      }
    }

    return finish(response);
  }

  /** The `baseUrl` this instance was created with (paginateLinks uses it to stay on-origin). */
  request.baseUrl = baseUrl;

  /** Like `request`, but resolves to the parsed JSON body (null for an empty body). */
  request.json = async (input, init) => {
    const response = await request(input, init);
    const { data, error } = await parseJsonSafe(response);
    if (error) throw error;
    return data;
  };

  /** A new fetch with these defaults merged over the current ones (headers and retry are merged, the rest replaced). */
  request.extend = (overrides = {}) =>
    createFetch(
      mergeDefaults(
        {
          ...defaults,
          // children share the parent's budget, breakers and cache unless they bring their own
          rateLimit: limiter || undefined,
          circuitBreaker: breakerFor || undefined,
          cache: cacheCfg || undefined,
        },
        overrides
      )
    );

  return request;
}

module.exports = { createFetch, HTTPError };
