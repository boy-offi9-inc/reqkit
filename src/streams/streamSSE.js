const { readSSE } = require("./readers");
const { HTTPError } = require("../errors/HTTPError");
const { normalizeError } = require("../errors/normalizeError");
const { getWaitMsFromHeaders, discardBody } = require("../internal/http");
const { abortableSleep } = require("../internal/sleep");

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(err) {
  const n = normalizeError(err);
  return !n.isAborted && (n.isNetworkError || n.isTimeout);
}

async function resolveHeaders(source) {
  const value = typeof source === "function" ? await source() : source;
  return new Headers(value || undefined);
}

/**
 * Connects to a Server-Sent Events endpoint and yields its events — and when
 * the connection drops (or the server closes it), reconnects by itself,
 * sending `Last-Event-ID` so the server can resume where you left off. This is
 * what the browser's `EventSource` does, but with `fetch`: custom headers,
 * POST bodies, AbortSignal, your own retry/backoff rules.
 *
 * ```js
 * for await (const { data } of streamSSE("https://api.example.com/events", { signal })) {
 *   console.log(data);
 * }
 * ```
 *
 * Reconnect behavior:
 *  - `Last-Event-ID` is sent on every reconnect (the last `id:` seen).
 *  - A server `retry: <ms>` field sets the base reconnect delay, like EventSource.
 *  - Waits back off exponentially (capped at `maxDelayMs`) while connecting keeps
 *    failing; 429/503 `Retry-After` is honored. A connection that delivered at
 *    least one event resets the failure count (only no-progress attempts count
 *    toward `retries`).
 *  - HTTP 204 means "stop reconnecting" (iteration ends). A non-retryable
 *    status (e.g. 401/404) or a wrong content-type throws immediately.
 *  - Only GET reconnects by default. For other methods (e.g. a POST that starts
 *    an LLM stream) re-sending the request could repeat side effects, so
 *    nothing is retried unless you pass `reconnect: true`.
 *  - Breaking out of the loop, or aborting `signal`, closes the connection.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch=globalThis.fetch] - e.g. a createFetch() instance
 * @param {string} [opts.method="GET"]
 * @param {HeadersInit | (() => HeadersInit | Promise<HeadersInit>)} [opts.headers] -
 *   a function is called before every (re)connect — handy for refreshing a token
 * @param {BodyInit} [opts.body]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.lastEventId] - resume from here on the very first connect
 * @param {boolean} [opts.reconnect] - default: true for GET/HEAD, false otherwise
 * @param {number} [opts.retries=10] - consecutive failed connections before giving up (Infinity = never)
 * @param {number} [opts.reconnectDelayMs=1000] - base delay (the server's `retry:` overrides it)
 * @param {number} [opts.maxDelayMs=30000]
 * @param {(event: object) => boolean} [opts.stopWhen] - end the stream (no reconnect) after this event, e.g. `e => e.data === "[DONE]"`
 * @param {(info: {connections: number, lastEventId: string}) => void} [opts.onOpen]
 * @param {(info: {reason: "error"|"end"|"status", error?: any, status?: number, attempt: number, delayMs: number, lastEventId: string}) => void} [opts.onReconnect]
 * @returns {AsyncGenerator<{event: string, data: string, id: string, retry: number|undefined}>}
 */
async function* streamSSE(url, opts = {}) {
  const {
    fetch: fetchFn = globalThis.fetch,
    method = "GET",
    headers,
    body,
    signal,
    reconnect = method === "GET" || method === "HEAD",
    retries = 10,
    reconnectDelayMs = 1000,
    maxDelayMs = 30000,
    stopWhen,
    onOpen,
    onReconnect,
  } = opts;

  let lastId = opts.lastEventId || "";
  let baseDelay = reconnectDelayMs;
  let failures = 0; // consecutive connections that delivered nothing
  let connections = 0;

  for (;;) {
    signal?.throwIfAborted?.();
    let failure = null; // { reason, error?, status?, response? }
    let res = null;

    // ---- connect -----------------------------------------------------------
    try {
      const h = await resolveHeaders(headers);
      if (!h.has("accept")) h.set("accept", "text/event-stream");
      if (!h.has("cache-control")) h.set("cache-control", "no-cache");
      if (lastId) h.set("last-event-id", lastId);
      res = await fetchFn(url, { method, headers: h, body, signal });
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (err instanceof HTTPError) {
        if (!isRetryableStatus(err.status)) throw err;
        failure = { reason: "status", status: err.status, response: err.response, error: err };
      } else if (isRetryableError(err)) {
        failure = { reason: "error", error: err };
      } else {
        throw err;
      }
    }

    // ---- inspect the response ---------------------------------------------
    if (!failure) {
      if (res.status === 204) {
        await discardBody(res);
        return; // the server's way of saying "don't reconnect"
      }
      if (!res.ok) {
        if (!isRetryableStatus(res.status)) {
          await discardBody(res);
          throw new HTTPError(res, { method, url });
        }
        failure = { reason: "status", status: res.status, response: res };
      } else {
        const type = res.headers.get("content-type") || "";
        if (!/text\/event-stream/i.test(type)) {
          await discardBody(res);
          throw Object.assign(new Error(`streamSSE: expected "text/event-stream" but the server sent "${type || "no content-type"}"`), {
            code: "SSE_BAD_CONTENT_TYPE",
          });
        }
      }
    }

    // ---- stream ------------------------------------------------------------
    let gotEvent = false;
    if (!failure) {
      connections++;
      if (onOpen) onOpen({ connections, lastEventId: lastId });
      try {
        for await (const event of readSSE(res, { signal })) {
          gotEvent = true;
          lastId = event.id;
          if (event.retry !== undefined) baseDelay = event.retry;
          yield event;
          if (stopWhen && stopWhen(event)) return;
        }
        failure = { reason: "end" };
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        if (!isRetryableError(err)) throw err;
        failure = { reason: "error", error: err };
      }
    }

    // ---- decide whether and when to reconnect ------------------------------
    if (!reconnect) {
      if (failure.reason === "end") return;
      if (failure.reason === "status") {
        throw failure.error || new HTTPError(failure.response, { method, url });
      }
      throw failure.error;
    }

    // A connection that delivered events made progress: reconnect promptly and
    // start the failure count over. Only no-progress attempts count toward `retries`.
    failures = gotEvent ? 0 : failures + 1;
    if (failures > retries) {
      if (failure.reason === "status") throw failure.error || new HTTPError(failure.response, { method, url });
      if (failure.reason === "error") throw failure.error;
      throw Object.assign(new Error(`streamSSE: the server keeps closing the stream without sending events — gave up after ${retries} retries`), {
        code: "SSE_GAVE_UP",
      });
    }

    let delayMs = Math.min(baseDelay * 2 ** Math.max(failures - 1, 0), maxDelayMs);
    if (failure.reason === "status" && failure.response) {
      const headerMs = getWaitMsFromHeaders(failure.response.headers);
      if (headerMs !== null) delayMs = Math.min(headerMs, 60000);
      await discardBody(failure.response);
    }
    delayMs += Math.random() * delayMs * 0.1; // a little jitter so clients don't reconnect in lockstep

    if (onReconnect) {
      onReconnect({
        reason: failure.reason,
        error: failure.error,
        status: failure.status,
        attempt: Math.max(failures, 1),
        delayMs,
        lastEventId: lastId,
      });
    }
    await abortableSleep(delayMs, signal);
  }
}

module.exports = { streamSSE };
