/**
 * Normalizes errors from fetch, axios, node's http/https, and generic
 * Error objects into one consistent shape:
 *   { message, status, code, isNetworkError, isTimeout, cause }
 *
 * Every field is always present (null/false when not applicable) so callers
 * can destructure without existence checks.
 */
function normalizeError(err) {
  const base = {
    message: "Unknown error",
    status: null,
    code: null,
    isNetworkError: false,
    isTimeout: false,
    cause: err,
  };

  if (!err) return base;

  // axios error shape: err.response.{status,data}, err.request, err.code
  if (err.isAxiosError || (err.response && typeof err.response.status === "number" && err.config)) {
    return {
      message: err.response?.data?.message || err.message || "Request failed",
      status: err.response?.status ?? null,
      code: err.code ?? null,
      isNetworkError: !err.response && Boolean(err.request),
      isTimeout: err.code === "ECONNABORTED" || /timeout/i.test(err.message || ""),
      cause: err,
    };
  }

  // fetch Response passed in directly (not thrown, but common enough to handle)
  if (typeof err.status === "number" && typeof err.ok === "boolean") {
    return {
      message: err.statusText || `Request failed with status ${err.status}`,
      status: err.status,
      code: null,
      isNetworkError: false,
      isTimeout: false,
      cause: err,
    };
  }

  // our own TimeoutError, or DOMException from AbortController
  if (err.name === "AbortError" || err.name === "TimeoutError" || err.code === "ETIMEDOUT") {
    return {
      message: err.message || "Request timed out",
      status: null,
      code: "ETIMEDOUT",
      isNetworkError: false,
      isTimeout: true,
      cause: err,
    };
  }

  // node http/https / undici network-level failures
  if (err.code && /^E[A-Z]+$/.test(err.code)) {
    return {
      message: err.message || `Network error (${err.code})`,
      status: null,
      code: err.code,
      isNetworkError: true,
      isTimeout: false,
      cause: err,
    };
  }

  return {
    message: err.message || String(err),
    status: err.status ?? err.statusCode ?? null,
    code: err.code ?? null,
    isNetworkError: false,
    isTimeout: false,
    cause: err,
  };
}

module.exports = { normalizeError };
