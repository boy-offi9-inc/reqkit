class BodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`Response body exceeded the ${maxBytes}-byte limit`);
    this.name = "BodyTooLargeError";
    this.code = "EBODYTOOLARGE";
    this.maxBytes = maxBytes;
  }
}

function cancelQuietly(reader) {
  try {
    const p = reader.cancel();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    // already closed / released — nothing to do
  }
}

/**
 * Reads a fetch Response body while reporting progress, and returns the
 * fully collected bytes as a Uint8Array. Works for any streamed response,
 * not just file downloads — same shape whether it's a media file, a large
 * JSON payload, or anything else worth showing progress for.
 *
 * `total` is null (and `percent` with it) when the size isn't trustworthy:
 * no Content-Length, or a Content-Encoding is applied (Content-Length is then
 * the *compressed* size while fetch hands you *decompressed* bytes, so
 * loaded could exceed total). `percent` is always clamped to 0–100.
 *
 * @param {Response} response
 * @param {(progress: { loaded: number, total: number | null, percent: number | null }) => void} [onProgress]
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] - abort with BodyTooLargeError once more
 *   than this many bytes have been received
 * @param {AbortSignal} [opts.signal] - cancels the read; rejects with the
 *   signal's reason (an AbortError by default)
 * @returns {Promise<Uint8Array>}
 */
async function withProgress(response, onProgress, opts = {}) {
  const { maxBytes, signal } = opts;
  signal?.throwIfAborted?.();

  if (!response.body || typeof response.body.getReader !== "function") {
    // No streaming support available — fall back to a single-shot read,
    // still reporting one final progress event so callers don't need a branch.
    const buf = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted?.();
    if (maxBytes !== undefined && buf.byteLength > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
    if (onProgress) {
      onProgress({ loaded: buf.byteLength, total: buf.byteLength, percent: 100 });
    }
    return buf;
  }

  const encoding = response.headers?.get?.("content-encoding");
  const encoded = Boolean(encoding) && encoding.trim().toLowerCase() !== "identity";
  const contentLength = response.headers?.get?.("content-length");
  const parsed = contentLength ? Number(contentLength) : NaN;
  const total = !encoded && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;

  const reader = response.body.getReader();

  // Fail fast when the declared size already exceeds the cap.
  if (maxBytes !== undefined && total !== null && total > maxBytes) {
    cancelQuietly(reader);
    throw new BodyTooLargeError(maxBytes);
  }

  const onAbort = () => cancelQuietly(reader);
  signal?.addEventListener("abort", onAbort, { once: true });

  const chunks = [];
  let loaded = 0;
  let finished = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      // reader.cancel() on abort makes read() resolve as done — check the
      // signal first so an aborted read never looks like a complete one.
      signal?.throwIfAborted?.();
      if (done) break;

      chunks.push(value);
      loaded += value.byteLength;

      if (maxBytes !== undefined && loaded > maxBytes) {
        throw new BodyTooLargeError(maxBytes);
      }

      if (onProgress) {
        onProgress({
          loaded,
          total,
          percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : null,
        });
      }
    }
    finished = true;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) cancelQuietly(reader);
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

module.exports = { withProgress, BodyTooLargeError };
