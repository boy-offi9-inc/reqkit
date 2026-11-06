/**
 * Normalizes errors from fetch, axios, node's http/https, undici and generic
 * Error objects into one consistent shape:
 *   { message, status, code, isNetworkError, isTimeout, isAborted, cause }
 *
 * Every field is always present (null/false when not applicable) so callers
 * can destructure without existence checks.
 *
 * - `isTimeout` is true only for real timeouts (reqkit's TimeoutError,
 *   AbortSignal.timeout(), ETIMEDOUT, undici timeouts) — not for a plain
 *   user-initiated abort.
 * - `isAborted` is true when the request was cancelled on purpose
 *   (AbortController.abort(), axios cancel).
 */

function shape(err, overrides) {
  return {
    message: "Unknown error",
    status: null,
    code: null,
    isNetworkError: false,
    isTimeout: false,
    isAborted: false,
    cause: err,
    ...overrides,
  };
}

// Node's fetch (undici) throws `TypeError: fetch failed` and puts the real
// reason (ECONNREFUSED, ENOTFOUND, UND_ERR_*...) on `err.cause`, sometimes
// inside an AggregateError. Walk the chain to find the first string code.
function findCode(err) {
  const seen = new Set();
  const queue = [err];
  while (queue.length && seen.size < 10) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (typeof cur.code === "string") return cur.code;
    queue.push(cur.cause);
    if (Array.isArray(cur.errors)) queue.push(...cur.errors);
  }
  return null;
}

function isTimeoutCode(code) {
  return code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || /^UND_ERR_.*TIMEOUT$/.test(code || "");
}

function isNetworkCode(code) {
  if (!code) return false;
  return /^E[A-Z0-9]+$/.test(code) || code === "EAI_AGAIN" || code === "EAI_FAIL" || code.startsWith("UND_ERR_");
}

// Browsers and Node throw a bare TypeError for network-level fetch failures.
const FETCH_NETWORK_MESSAGE =
  /fetch failed|failed to fetch|network ?request failed|load failed|networkerror when attempting to fetch|^terminated$|^network error$/i;

function isFetchNetworkTypeError(err) {
  return err.name === "TypeError" && FETCH_NETWORK_MESSAGE.test(err.message || "");
}

function normalizeError(err) {
  if (!err) return shape(err);

  // axios error shape: err.response.{status,data}, err.request, err.code
  if (err.isAxiosError || (err.response && typeof err.response.status === "number" && err.config)) {
    return shape(err, {
      message: err.response?.data?.message || err.message || "Request failed",
      status: err.response?.status ?? null,
      code: err.code ?? null,
      isNetworkError: !err.response && Boolean(err.request),
      isTimeout: err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || /timeout/i.test(err.message || ""),
      isAborted: err.code === "ERR_CANCELED" || err.name === "CanceledError",
    });
  }

  // fetch Response passed in directly (not thrown, but common enough to handle)
  if (typeof err.status === "number" && typeof err.ok === "boolean") {
    return shape(err, {
      message: err.statusText || `Request failed with status ${err.status}`,
      status: err.status,
    });
  }

  const chainCode = findCode(err);

  // reqkit's TimeoutError, AbortSignal.timeout() (DOMException TimeoutError),
  // node ETIMEDOUT, undici connect/headers/body timeouts
  if (err.name === "TimeoutError" || isTimeoutCode(chainCode)) {
    return shape(err, {
      message: err.message || "Request timed out",
      code: chainCode || "ETIMEDOUT",
      isTimeout: true,
    });
  }

  // Deliberate cancellation via AbortController — not a timeout.
  if (err.name === "AbortError") {
    return shape(err, {
      message: err.message || "Request aborted",
      code: "ABORT_ERR",
      isAborted: true,
    });
  }

  // node http/https / undici network-level failures, including
  // `TypeError: fetch failed` with the real code on err.cause
  if (isNetworkCode(chainCode) || isFetchNetworkTypeError(err)) {
    return shape(err, {
      message: err.message || `Network error (${chainCode})`,
      code: chainCode,
      isNetworkError: true,
    });
  }

  return shape(err, {
    message: err.message || String(err),
    status: err.status ?? err.statusCode ?? err.response?.status ?? err.response?.statusCode ?? null,
    code: err.code ?? null,
  });
}

module.exports = { normalizeError };
