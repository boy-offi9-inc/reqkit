function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a Retry-After header value into milliseconds. Per HTTP spec it's
 * either an integer number of seconds, or an HTTP-date.
 */
function parseRetryAfter(headerValue) {
  if (!headerValue) return null;

  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(headerValue);
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

/**
 * Retries a fetch-like call, honoring Retry-After / X-RateLimit-Reset
 * headers on 429/503 responses instead of blind exponential backoff — most
 * generic retry libraries treat rate-limit responses like any other failure
 * and ignore the header the server is explicitly giving you.
 *
 * `fn` should return a fetch Response (or anything with `.status` and
 * `.headers.get()`).
 *
 * @param {() => Promise<Response>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries=3]
 * @param {number[]} [opts.retryStatusCodes=[429, 503]]
 * @param {number} [opts.fallbackDelayMs=1000] - used when no usable header is present
 * @param {number} [opts.maxDelayMs=60000]
 * @param {(status: number, waitMs: number, attempt: number) => void} [opts.onRetry]
 */
async function retryAfterAware(fn, opts = {}) {
  const {
    retries = 3,
    retryStatusCodes = [429, 503],
    fallbackDelayMs = 1000,
    maxDelayMs = 60000,
    onRetry,
  } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fn(attempt);

    if (!retryStatusCodes.includes(response.status) || attempt === retries) {
      return response;
    }

    const headerWaitMs = getWaitMsFromHeaders(response.headers);
    const waitMs = Math.min(headerWaitMs ?? fallbackDelayMs * 2 ** attempt, maxDelayMs);

    if (onRetry) onRetry(response.status, waitMs, attempt);
    await delay(waitMs);
  }
}

module.exports = { retryAfterAware, parseRetryAfter, getWaitMsFromHeaders };
