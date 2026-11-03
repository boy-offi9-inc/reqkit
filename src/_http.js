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

// Reset headers come in two flavors: a delta in seconds ("30", the IETF
// RateLimit-Reset draft, Discord's *-Reset-After) or an absolute epoch
// (GitHub/Twitter style, seconds or ms). Anything under ~31 years in seconds
// can't be a real epoch, so treat it as a delta.
function parseResetMs(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return null;
  if (n < 1e9) return n * 1000;
  const epochMs = n > 4102444800 ? n : n * 1000;
  return Math.max(0, epochMs - Date.now());
}

function readHeader(headers, ...names) {
  for (const name of names) {
    const v = headers.get(name);
    if (v !== null && v !== undefined && v !== "") return v;
  }
  return null;
}

/**
 * Reads a wait time from common rate-limit headers, trying Retry-After first,
 * then falling back to X-RateLimit-Reset(-After) if present.
 */
function getWaitMsFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function") return null;

  const retryAfter = parseRetryAfter(headers.get("retry-after"));
  if (retryAfter !== null) return retryAfter;

  return parseResetMs(
    readHeader(headers, "x-ratelimit-reset-after", "x-ratelimit-reset", "x-rate-limit-reset", "ratelimit-reset")
  );
}

/**
 * Everything useful a response says about rate limits:
 *   { remaining: number|null, resetMs: number|null, retryAfterMs: number|null }
 * Understands X-RateLimit-*, X-Rate-Limit-*, RateLimit-* and Retry-After.
 */
function getRateLimitInfo(headers) {
  const info = { remaining: null, resetMs: null, retryAfterMs: null };
  if (!headers || typeof headers.get !== "function") return info;

  const remaining = readHeader(headers, "x-ratelimit-remaining", "x-rate-limit-remaining", "ratelimit-remaining");
  if (remaining !== null && !Number.isNaN(Number(remaining))) info.remaining = Number(remaining);

  info.resetMs = parseResetMs(
    readHeader(headers, "x-ratelimit-reset-after", "x-ratelimit-reset", "x-rate-limit-reset", "ratelimit-reset")
  );
  info.retryAfterMs = parseRetryAfter(headers.get("retry-after"));
  return info;
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

module.exports = { parseRetryAfter, parseResetMs, getWaitMsFromHeaders, getRateLimitInfo, discardBody };
