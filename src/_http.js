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

module.exports = { parseRetryAfter, getWaitMsFromHeaders, discardBody };
