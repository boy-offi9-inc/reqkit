/**
 * Parses a fetch Response (or raw string) as JSON without throwing.
 * Returns { data, error } — exactly one is non-null.
 *
 * @param {Response | string} input
 */
async function parseJsonSafe(input) {
  let text;
  try {
    text = typeof input === "string" ? input : await input.text();
  } catch (err) {
    return { data: null, error: err };
  }

  if (!text) {
    return { data: null, error: null };
  }

  try {
    return { data: JSON.parse(text), error: null };
  } catch (err) {
    return { data: null, error: err };
  }
}

module.exports = { parseJsonSafe };
