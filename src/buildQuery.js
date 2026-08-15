/**
 * Builds a query string from a params object. Skips null/undefined values,
 * repeats the key for arrays (`?tag=a&tag=b`), and encodes everything.
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

    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === null || v === undefined) continue;
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
      }
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }

  return pairs.join("&");
}

module.exports = { buildQuery };
