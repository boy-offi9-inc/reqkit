/**
 * Reads a fetch Response body while reporting progress, and returns the
 * fully collected bytes as a Uint8Array. Works for any streamed response,
 * not just file downloads — same shape whether it's a media file, a large
 * JSON payload, or anything else worth showing progress for.
 *
 * If the server doesn't send Content-Length, `total` will be null in the
 * progress callback — the loaded count is still accurate.
 *
 * @param {Response} response
 * @param {(progress: { loaded: number, total: number | null, percent: number | null }) => void} onProgress
 * @returns {Promise<Uint8Array>}
 */
async function withProgress(response, onProgress) {
  if (!response.body || typeof response.body.getReader !== "function") {
    // No streaming support available — fall back to a single-shot read,
    // still reporting one final progress event so callers don't need a branch.
    const buf = new Uint8Array(await response.arrayBuffer());
    if (onProgress) {
      onProgress({ loaded: buf.byteLength, total: buf.byteLength, percent: 100 });
    }
    return buf;
  }

  const contentLength = response.headers?.get?.("content-length");
  const total = contentLength ? Number(contentLength) : null;

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    loaded += value.byteLength;

    if (onProgress) {
      onProgress({
        loaded,
        total,
        percent: total ? Math.round((loaded / total) * 100) : null,
      });
    }
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

module.exports = { withProgress };
