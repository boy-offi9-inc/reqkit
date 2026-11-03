const { HTTPError } = require("./HTTPError");
const { BodyTooLargeError } = require("./withProgress");
const { normalizeError } = require("./normalizeError");
const { getWaitMsFromHeaders } = require("./_http");
const { abortableSleep } = require("./_sleep");

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function parseContentRange(header) {
  // "bytes 100-199/1000" (total may be "*")
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(header || "").trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === "*" ? null : Number(m[3]) };
}

function isRetryable(err) {
  if (err instanceof BodyTooLargeError) return false;
  if (err instanceof HTTPError) return RETRYABLE_STATUS.has(err.status);
  const n = normalizeError(err);
  if (n.isAborted) return false;
  return n.isNetworkError || n.isTimeout;
}

/**
 * Downloads a URL into memory and, if the connection drops mid-body, resumes
 * from where it stopped with an HTTP `Range` request instead of starting
 * over. Uses `If-Range` with the first response's strong ETag (or
 * Last-Modified) so a file that changed on the server is restarted rather
 * than stitched together wrongly. If the server ignores Range, it simply
 * restarts from zero.
 *
 * `retries` counts consecutive attempts *without progress* — a flaky link
 * that keeps making headway keeps going. Honors Retry-After on 429/503.
 *
 * ```js
 * const bytes = await downloadResumable(url, {
 *   onProgress: ({ percent }) => console.log(percent),
 *   maxBytes: 200 * 1024 * 1024,
 * });
 * ```
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch=globalThis.fetch] - e.g. `createFetch(...)` or a mock
 * @param {HeadersInit} [opts.headers]
 * @param {number} [opts.retries=5]
 * @param {number} [opts.baseDelayMs=500]
 * @param {number} [opts.maxDelayMs=10000]
 * @param {(p: {loaded: number, total: number | null, percent: number | null}) => void} [opts.onProgress]
 * @param {number} [opts.maxBytes] - throws BodyTooLargeError past this
 * @param {AbortSignal} [opts.signal]
 * @param {(err: any, attempt: number, delayMs: number, info: {resumeFrom: number}) => void} [opts.onRetry]
 * @returns {Promise<Uint8Array>}
 */
async function downloadResumable(url, opts = {}) {
  const {
    fetch: fetchFn = globalThis.fetch,
    headers,
    retries = 5,
    baseDelayMs = 500,
    maxDelayMs = 10000,
    onProgress,
    maxBytes,
    signal,
    onRetry,
  } = opts;

  const chunks = [];
  let loaded = 0;
  let total = null;
  let validator = null;
  let attempt = 0; // consecutive attempts without progress

  const report = () => {
    if (onProgress) {
      onProgress({ loaded, total, percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : null });
    }
  };

  for (;;) {
    signal?.throwIfAborted?.();
    const loadedBefore = loaded;

    try {
      const reqHeaders = new Headers(headers || undefined);
      // Range offsets count encoded bytes, so ask for an uncompressed body.
      if (!reqHeaders.has("accept-encoding")) reqHeaders.set("accept-encoding", "identity");
      if (loaded > 0) {
        reqHeaders.set("range", `bytes=${loaded}-`);
        if (validator) reqHeaders.set("if-range", validator);
      }

      const res = await fetchFn(url, { headers: reqHeaders, signal });

      if (res.status === 416 && loaded > 0) {
        // Our offset no longer fits the file — start over, without burning a retry.
        await res.body?.cancel?.().catch(() => {});
        chunks.length = 0;
        loaded = 0;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel?.().catch(() => {});
        throw new HTTPError(res, { method: "GET", url });
      }

      const encoding = res.headers.get("content-encoding");
      const encoded = Boolean(encoding) && encoding.trim().toLowerCase() !== "identity";

      if (loaded > 0) {
        const range = res.status === 206 ? parseContentRange(res.headers.get("content-range")) : null;
        if (!range || range.start !== loaded || encoded) {
          // Server ignored Range, the file changed (If-Range failed), or the
          // bytes don't line up: discard and restart from the beginning.
          chunks.length = 0;
          loaded = 0;
        }
      }

      if (loaded === 0) {
        const range = res.status === 206 ? parseContentRange(res.headers.get("content-range")) : null;
        const length = Number(res.headers.get("content-length"));
        total = encoded ? null : range ? range.total : Number.isFinite(length) && res.headers.has("content-length") ? length : null;
        const etag = res.headers.get("etag");
        validator = etag && !etag.startsWith("W/") ? etag : res.headers.get("last-modified");
      }

      if (maxBytes !== undefined && total !== null && total > maxBytes) {
        await res.body?.cancel?.().catch(() => {});
        throw new BodyTooLargeError(maxBytes);
      }

      if (!res.body || typeof res.body.getReader !== "function") {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (maxBytes !== undefined && buf.byteLength > maxBytes) throw new BodyTooLargeError(maxBytes);
        chunks.push(buf);
        loaded += buf.byteLength;
        total = total ?? loaded;
        report();
      } else {
        const reader = res.body.getReader();
        const onAbort = () => reader.cancel(signal.reason).catch(() => {});
        signal?.addEventListener("abort", onAbort, { once: true });
        let finished = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            signal?.throwIfAborted?.();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            if (maxBytes !== undefined && loaded > maxBytes) throw new BodyTooLargeError(maxBytes);
            report();
          }
          finished = true;
        } finally {
          signal?.removeEventListener("abort", onAbort);
          if (!finished) reader.cancel().catch(() => {});
        }
      }

      if (total !== null && loaded < total) {
        // Stream ended early without an error (some servers just close the socket).
        throw Object.assign(new Error(`Incomplete download: got ${loaded} of ${total} bytes`), { code: "ECONNRESET" });
      }

      const out = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (!isRetryable(err)) throw err;

      if (loaded > loadedBefore) attempt = 0; // it made progress — doesn't count against the budget
      if (attempt >= retries) throw err;

      let delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      if (err instanceof HTTPError) {
        const headerMs = getWaitMsFromHeaders(err.response && err.response.headers);
        if (headerMs !== null) delayMs = Math.min(headerMs, 60000);
      }
      attempt++;
      if (onRetry) onRetry(err, attempt, delayMs, { resumeFrom: loaded });
      await abortableSleep(delayMs, signal);
    }
  }
}

module.exports = { downloadResumable };
