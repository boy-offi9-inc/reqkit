// Non-plain objects (AbortSignal, Response, class instances, functions...)
// can't be meaningfully JSON-serialized — JSON.stringify turns every
// AbortSignal into "{}", which would make unrelated calls share one request.
// Give them a stable identity-based id instead.
const identityIds = new WeakMap();
let nextIdentityId = 1;

function identityOf(value) {
  let id = identityIds.get(value);
  if (id === undefined) {
    id = nextIdentityId++;
    identityIds.set(value, id);
  }
  return id;
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function keyReplacer(_key, value) {
  if (typeof value === "bigint") return { $bigint: String(value) };
  if (typeof value === "function") return { $ref: identityOf(value) };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return { $ref: identityOf(value) };

  // Sort plain-object keys so {a:1,b:2} and {b:2,a:1} dedupe together.
  const sorted = {};
  for (const k of Object.keys(value).sort()) sorted[k] = value[k];
  return sorted;
}

function defaultKeyFn(...args) {
  try {
    return JSON.stringify(args, keyReplacer);
  } catch {
    // Circular structures etc. Fall back to identity for objects.
    return args
      .map((a) => ((a && typeof a === "object") || typeof a === "function" ? `#${identityOf(a)}` : String(a)))
      .join("|");
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
 *   from the call arguments. By default plain data is compared by value
 *   (object key order doesn't matter) and anything else — AbortSignals,
 *   Responses, class instances, functions — by identity, so two calls with
 *   different AbortSignals are never merged.
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
