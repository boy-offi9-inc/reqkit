const { RetryAbortedError, sleep } = require("./_sleep");
const { normalizeError } = require("./normalizeError");

/**
 * Parses a Retry-After header value into milliseconds. Per HTTP spec it's
 * either an integer number of seconds, or an HTTP-date.
 */
function parseRetryAfter(headerValue) {
  if (headerValue === null || headerValue === undefined) return null;
  const value = String(headerValue).trim();
  if (!value) return null;

  // delta-seconds (spec says integer; tolerate "1.5" from sloppy servers)
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Number(value) * 1000;
  }

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

/**
 * Reads a wait time from common rate-limit headers, trying Retry-After first,
 * then falling back to X-RateLimit-Reset (epoch seconds or ms) if present.
 */
function getWaitMsFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function") return null;

  const retryAfter = parseRetryAfter(headers.get("retry-after"));
  if (retryAfter !== null) return retryAfter;

  const resetHeader = headers.get("x-ratelimit-reset") || headers.get("x-rate-limit-reset");
  if (resetHeader) {
    const resetValue = Number(resetHeader);
    if (!Number.isNaN(resetValue)) {
      // Could be epoch seconds or epoch ms — treat values below a
      // year-2100-in-seconds threshold as seconds.
      const resetMs = resetValue > 4102444800 ? resetValue : resetValue * 1000;
      return Math.max(0, resetMs - Date.now());
    }
  }

  return null;
}

function defaultShouldRetryError(err) {
  const normalized = normalizeError(err);
  return normalized.isNetworkError || normalized.isTimeout;
}

async function discardBody(response) {
  // An unread body keeps the underlying connection busy; cancel it before
  // we sit through a backoff and fire the next request.
  try {
    if (response.body && typeof response.body.cancel === "function" && !response.bodyUsed) {
      await response.body.cancel();
    }
  } catch {
    // locked / already consumed / not a web stream — safe to ignore
  }
}

/**
 * Retries a fetch-like call, honoring Retry-After / X-RateLimit-Reset
 * headers on 429/503 responses instead of blind exponential backoff — most
 * generic retry libraries treat rate-limit responses like any other failure
 * and ignore the header the server is explicitly giving you.
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
async function retryAfterAware(fn, opts = {}) {
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

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new RetryAbortedError(lastErr);

    let response;
    try {
      response = await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetryError(err, attempt)) throw err;

      const waitMs = Math.min(fallbackDelayMs * 2 ** attempt, maxDelayMs);
      if (onRetryError) onRetryError(err, waitMs, attempt);
      await sleep(waitMs, signal, err);
      continue;
    }

    if (!retryStatusCodes.includes(response.status) || attempt === retries) {
      return response;
    }

    const headerWaitMs = getWaitMsFromHeaders(response.headers);
    const waitMs = Math.min(headerWaitMs ?? fallbackDelayMs * 2 ** attempt, maxDelayMs);

    await discardBody(response);
    if (onRetry) onRetry(response.status, waitMs, attempt);
    await sleep(waitMs, signal);
  }
}

module.exports = { retryAfterAware, parseRetryAfter, getWaitMsFromHeaders };
