// Helpers for createFetch's response cache.

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function cacheKey(method, url, headers) {
  // Every request header is part of the key, so responses fetched with one
  // user's Authorization header can never be served to another.
  return `${method} ${url} ${JSON.stringify([...headers.entries()].sort())}`;
}

/**
 * Reads a response (via a clone — the original stays usable) into a plain,
 * storable entry. Returns null when the response must not be cached.
 */
async function snapshotResponse(response, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
  if (response.status !== 200) return null;

  const cacheControl = (response.headers.get("cache-control") || "").toLowerCase();
  if (/\bno-store\b/.test(cacheControl)) return null;
  if ((response.headers.get("vary") || "").trim() === "*") return null;

  const declared = Number(response.headers.get("content-length"));
  if (response.headers.has("content-length") && declared > maxBodyBytes) return null;

  const copy = response.clone();
  const buffer = await copy.arrayBuffer();
  if (buffer.byteLength > maxBodyBytes) return null;

  const headers = [];
  response.headers.forEach((value, key) => {
    // The body we stored is already decoded; replaying these would corrupt it.
    if (key === "content-encoding" || key === "content-length" || key === "transfer-encoding") return;
    headers.push([key, value]);
  });

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: new Uint8Array(buffer),
    storedAt: Date.now(),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

function entryToResponse(entry) {
  return new Response(entry.body.slice(), {
    status: entry.status,
    statusText: entry.statusText,
    headers: entry.headers,
  });
}

module.exports = { cacheKey, snapshotResponse, entryToResponse, DEFAULT_MAX_BODY_BYTES };
