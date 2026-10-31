function toParam(key, value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`buildQuery: value for "${key}" is an invalid Date`);
    }
    return value.toISOString();
  }
  if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(
      `buildQuery: value for "${key}" is not a primitive, Date or array of those — flatten it or JSON.stringify it first`
    );
  }
  return String(value);
}

/**
 * Builds a query string from a params object. Skips null/undefined values,
 * repeats the key for arrays (`?tag=a&tag=b`), serializes Dates as ISO 8601,
 * and encodes everything. Nested objects throw a TypeError instead of
 * silently becoming "[object Object]".
 *
 * Deliberately minimal — for full query-string parsing/nested-object support,
 * reach for `query-string` (sindresorhus) instead. This just covers the
 * common "build a query string from a flat params object" case with zero deps.
 *
 * @param {Record<string, unknown>} params
 */
function buildQuery(params) {
  if (!params) return "";

  const pairs = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;

    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === null || v === undefined) continue;
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(toParam(key, v))}`);
    }
  }

  return pairs.join("&");
}

module.exports = { buildQuery };
