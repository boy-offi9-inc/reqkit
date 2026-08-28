function defaultKeyFn(...args) {
  try {
    return JSON.stringify(args);
  } catch {
    // Fall back to a stable-ish key if args aren't JSON-serializable
    // (e.g. contain a function or circular ref).
    return args.map((a) => String(a)).join("|");
  }
}

/**
 * Wraps an async function so that concurrent calls with the same key share
 * a single in-flight promise instead of firing duplicate requests. Common
 * use case: several parts of a UI ask for the same resource at once (e.g. a
 * user profile) — only one network request actually goes out, and every
 * caller resolves with the same result.
 *
 * The in-flight entry is cleared as soon as the call settles (success or
 * failure), so the next call — even with the same key — always starts a
 * fresh request. This is deduplication of concurrent calls, not a cache.
 *
 * @param {(...args: any[]) => Promise<any>} fn
 * @param {object} [opts]
 * @param {(...args: any[]) => string} [opts.keyFn] - derives a dedupe key
 *   from the call arguments. Defaults to JSON.stringify(args).
 * @returns {(...args: any[]) => Promise<any>}
 */
function withDedupe(fn, opts = {}) {
  const { keyFn = defaultKeyFn } = opts;
  const inFlight = new Map();

  return function deduped(...args) {
    const key = keyFn(...args);

    if (inFlight.has(key)) {
      return inFlight.get(key);
    }

    const promise = Promise.resolve()
      .then(() => fn(...args))
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  };
}

module.exports = { withDedupe };
