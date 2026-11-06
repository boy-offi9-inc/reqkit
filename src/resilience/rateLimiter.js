const { abortableSleep } = require("../internal/sleep");
const { getRateLimitInfo } = require("../internal/http");

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e))
    );
  });
}

/**
 * A *proactive* rate limiter: slows you down before the server has to say
 * 429. Two things feed it:
 *  1. your own budget — `requests` per `perMs` (sliding window), and
 *  2. what the server tells you — `update(response)` reads X-RateLimit-* /
 *     RateLimit-* / Retry-After and pauses everything once `remaining` hits 0
 *     (or the server sent Retry-After), until the reset time.
 *
 * Callers are served FIFO.
 *
 * ```js
 * const rl = createRateLimiter({ requests: 10, perMs: 1000 });
 * const res = await rl.run(() => fetch(url)); // acquire → call → learn from headers
 * ```
 *
 * @param {object} [opts]
 * @param {number} [opts.requests=Infinity] - max requests per window
 * @param {number} [opts.perMs=1000] - window length
 */
function createRateLimiter(opts = {}) {
  const { requests = Infinity, perMs = 1000 } = opts;
  if (requests !== Infinity && !(Number.isInteger(requests) && requests >= 1)) {
    throw new TypeError("createRateLimiter: `requests` must be an integer >= 1 (or Infinity)");
  }
  if (!(typeof perMs === "number" && perMs > 0 && Number.isFinite(perMs))) {
    throw new TypeError("createRateLimiter: `perMs` must be a positive number");
  }

  const stamps = [];
  let blockedUntil = 0;
  let tail = Promise.resolve();

  async function take(signal) {
    let waitedMs = 0;
    for (;;) {
      signal?.throwIfAborted?.();
      const now = Date.now();
      while (stamps.length > 0 && stamps[0] <= now - perMs) stamps.shift();

      let waitMs = 0;
      if (blockedUntil > now) waitMs = blockedUntil - now;
      else if (stamps.length >= requests) waitMs = stamps[0] + perMs - now;

      if (waitMs <= 0) {
        stamps.push(now);
        return waitedMs;
      }
      const waitStartedAt = Date.now();
      await abortableSleep(waitMs, signal);
      waitedMs += Date.now() - waitStartedAt;
    }
  }

  /** Resolves with the time spent waiting. Rejects if aborted while waiting. */
  function acquire({ signal } = {}) {
    const turn = tail.then(() => take(signal));
    tail = turn.catch(() => {});
    return abortable(turn, signal);
  }

  /** Feed a response (anything with `.headers`/`.status`) so the limiter learns the server's limits. */
  function update(response) {
    if (!response || !response.headers) return;
    const { remaining, resetMs, retryAfterMs } = getRateLimitInfo(response.headers);
    let blockMs = null;
    if (retryAfterMs !== null && (response.status === 429 || response.status === 503)) blockMs = retryAfterMs;
    else if (remaining === 0 && resetMs !== null) blockMs = resetMs;
    if (blockMs !== null) blockedUntil = Math.max(blockedUntil, Date.now() + blockMs);
  }

  /** acquire → fn() → update(result). Errors thrown by fn propagate (the slot stays spent). */
  async function run(fn, { signal } = {}) {
    await acquire({ signal });
    const result = await fn();
    update(result);
    return result;
  }

  return {
    acquire,
    update,
    run,
    /** Ms until the server-imposed pause ends (0 if none). */
    get blockedForMs() {
      return Math.max(0, blockedUntil - Date.now());
    },
    /** Forget all history and server hints. */
    reset() {
      stamps.length = 0;
      blockedUntil = 0;
    },
  };
}

module.exports = { createRateLimiter };
