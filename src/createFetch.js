const { withRetry, RetryAbortedError } = require("./withRetry");
const { withTimeout } = require("./withTimeout");
const { withDedupe } = require("./withDedupe");
const { buildQuery } = require("./buildQuery");
const { parseJsonSafe } = require("./parseJsonSafe");
const { normalizeError } = require("./normalizeError");

const DEFAULT_RETRY_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504];
// Safe to repeat without side effects. POST/PATCH are deliberately absent.
const DEFAULT_RETRY_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];

class HTTPError extends Error {
  constructor(response, request) {
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    super(`Request failed with status ${response.status}${statusText}: ${request.method} ${request.url}`);
    this.name = "HTTPError";
    this.status = response.status;
    this.statusText = response.statusText || "";
    this.response = response;
    this.url = request.url;
    this.method = request.method;
  }
}

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

function mergeDefaults(base, extra) {
  const headersOf = (d) => d.headers;
  const merged = { ...base, ...extra };

  if (base.headers || extra.headers) {
    merged.headers = async () => {
      const a = await resolveHeaders(headersOf(base));
      const b = await resolveHeaders(headersOf(extra));
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
 *  - concurrent GET de-duplication (withDedupe)
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
    dedupe = false,
    throwHttpErrors: defaultThrow = true,
    fetch: customFetch,
    onRequest,
    onResponse,
  } = defaults;

  const doFetch = (...args) => (customFetch || globalThis.fetch)(...args);

  // Shared in-flight GETs. Every caller gets its own clone of the response so
  // body reads don't fight each other.
  const sharedFetch = withDedupe((key, url, init) => doFetch(url, init), { keyFn: (key) => key });

  async function request(input, init = {}) {
    const {
      query,
      json,
      timeout = defaultTimeout,
      retry: retryOpt,
      throwHttpErrors = defaultThrow,
      signal,
      headers: initHeaders,
      ...fetchInit
    } = init;

    const method = String(fetchInit.method || "GET").toUpperCase();
    const headers = mergeHeaders(await resolveHeaders(defaultHeaders), new Headers(initHeaders || undefined));

    let body = fetchInit.body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }

    const ctx = { url: joinUrl(baseUrl, input, query), init: { ...fetchInit, method, headers, body } };
    if (onRequest) await onRequest(ctx);
    const finalHeaders = ctx.init.headers instanceof Headers ? ctx.init.headers : new Headers(ctx.init.headers);
    const finalMethod = String(ctx.init.method || method).toUpperCase();

    // --- retry policy ------------------------------------------------------
    const retryCfg = retryOpt === false || defaultRetry === false ? false : { ...defaultRetry, ...retryOpt };
    const methods = (retryCfg && retryCfg.methods) || DEFAULT_RETRY_METHODS;
    const hasIdempotencyKey = finalHeaders.has("idempotency-key");
    const canRetry =
      retryCfg !== false &&
      !isStreamBody(ctx.init.body) && // a consumed stream can't be replayed
      (methods.map((m) => m.toUpperCase()).includes(finalMethod) || hasIdempotencyKey);

    const attemptOnce = () =>
      withTimeout(
        (attemptSignal) => {
          const attemptInit = { ...ctx.init, method: finalMethod, headers: finalHeaders, signal: attemptSignal };
          const useDedupe = dedupe && !signal && !ctx.init.body && (finalMethod === "GET" || finalMethod === "HEAD");
          if (!useDedupe) return doFetch(ctx.url, attemptInit);
          // No per-attempt signal on a shared request: aborting one caller
          // must never cancel everyone else's.
          // It still gets its own timeout so a hung server can't leak the request.
          const sharedInit = { ...attemptInit, signal: timeout === false ? undefined : AbortSignal.timeout(timeout) };
          const key = `${finalMethod} ${ctx.url} ${JSON.stringify([...finalHeaders.entries()].sort())}`;
          return sharedFetch(key, ctx.url, sharedInit).then((res) => res.clone());
        },
        timeout === false ? Infinity : timeout,
        { signal }
      );

    const { statusCodes, methods: _methods, retries = 2, shouldRetry: customShouldRetry, ...retryRest } = retryCfg || {};

    let response;
    try {
      response = canRetry
        ? await withRetry(attemptOnce, {
            ...retryRest,
            retries,
            retryStatusCodes: statusCodes || DEFAULT_RETRY_STATUS_CODES,
            shouldRetry:
              customShouldRetry ||
              ((err) => {
                const n = normalizeError(err);
                return n.isNetworkError || n.isTimeout;
              }),
            signal,
          })
        : await attemptOnce();
    } catch (err) {
      // Present a user abort as the plain AbortError they caused, not as retry internals.
      if (err instanceof RetryAbortedError && signal && signal.aborted) throw signal.reason ?? err;
      throw err;
    }

    if (onResponse) await onResponse({ url: ctx.url, init: ctx.init, response });
    if (throwHttpErrors && !response.ok) {
      throw new HTTPError(response, { method: finalMethod, url: ctx.url });
    }
    return response;
  }

  /** Like `request`, but resolves to the parsed JSON body (null for an empty body). */
  request.json = async (input, init) => {
    const response = await request(input, init);
    const { data, error } = await parseJsonSafe(response);
    if (error) throw error;
    return data;
  };

  /** A new fetch with these defaults merged over the current ones (headers and retry are merged, the rest replaced). */
  request.extend = (overrides = {}) => createFetch(mergeDefaults(defaults, overrides));

  return request;
}

module.exports = { createFetch, HTTPError };
