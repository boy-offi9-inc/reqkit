const { withRetry } = require("./retry");
const { normalizeError } = require("../errors/normalizeError");
const { parseRetryAfter, getWaitMsFromHeaders } = require("../internal/http");

function defaultShouldRetryError(err) {
  const normalized = normalizeError(err);
  return normalized.isNetworkError || normalized.isTimeout;
}

/**
 * Retries a fetch-like call, honoring Retry-After / X-RateLimit-Reset
 * headers on 429/503 responses instead of blind exponential backoff — most
 * generic retry libraries treat rate-limit responses like any other failure
 * and ignore the header the server is explicitly giving you.
 *
 * This is a thin preset over `withRetry` (retryStatusCodes + Retry-After,
 * no jitter, network errors/timeouts only for thrown errors). Reach for
 * `withRetry` directly when you need jitter, `maxRetryTime`, `StopRetry`,
 * `calculateDelay`, ...
 *
 * Also retries thrown network errors / timeouts (see `shouldRetryError`),
 * and the whole loop — including any backoff wait — can be cancelled with
 * `signal`. The body of each response that gets retried is cancelled so the
 * connection is released.
 *
 * `fn` should return a fetch Response (or anything with `.status` and
 * `.headers.get()`).
 *
 * @param {(attempt: number) => Promise<Response>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries=3]
 * @param {number[]} [opts.retryStatusCodes=[429, 503]]
 * @param {number} [opts.fallbackDelayMs=1000] - used when no usable header is present
 * @param {number} [opts.maxDelayMs=60000]
 * @param {(status: number, waitMs: number, attempt: number) => void} [opts.onRetry]
 * @param {(err: any, attempt: number) => boolean} [opts.shouldRetryError] -
 *   decides whether a thrown error is retried. Default: network errors and
 *   timeouts only.
 * @param {(err: any, waitMs: number, attempt: number) => void} [opts.onRetryError]
 * @param {AbortSignal} [opts.signal] - cancels the retry loop, throwing
 *   RetryAbortedError
 */
function retryAfterAware(fn, opts = {}) {
  const {
    retries = 3,
    retryStatusCodes = [429, 503],
    fallbackDelayMs = 1000,
    maxDelayMs = 60000,
    onRetry,
    shouldRetryError = defaultShouldRetryError,
    onRetryError,
    signal,
  } = opts;

  return withRetry(fn, {
    retries,
    retryStatusCodes,
    baseDelayMs: fallbackDelayMs,
    maxDelayMs,
    maxRetryAfterMs: maxDelayMs,
    factor: 2,
    jitter: 0,
    shouldRetry: shouldRetryError,
    onRetry: (err, attempt, waitMs, ctx) => {
      if (ctx.reason === "result") {
        if (onRetry) onRetry(ctx.status, waitMs, attempt);
      } else if (onRetryError) {
        onRetryError(err, waitMs, attempt);
      }
    },
    signal,
  });
}

module.exports = { retryAfterAware, parseRetryAfter, getWaitMsFromHeaders };
