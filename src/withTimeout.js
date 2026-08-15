class TimeoutError extends Error {
  constructor(ms) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.code = "ETIMEDOUT";
  }
}

/**
 * Races an async function against a timeout. If `fn` accepts an AbortSignal
 * as its argument, it's passed one so the underlying request can actually be
 * cancelled (not just abandoned) — e.g. `withTimeout(signal => fetch(url, { signal }), 5000)`.
 *
 * @param {(signal: AbortSignal) => Promise<any>} fn
 * @param {number} ms
 */
async function withTimeout(fn, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  const timeoutPromise = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new TimeoutError(ms)));
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } catch (err) {
    // If our timeout is what triggered the abort, always surface TimeoutError —
    // regardless of whether fn's own rejection or our timeout promise "won"
    // the race (that's a listener-registration-order detail callers shouldn't
    // have to think about).
    if (controller.signal.aborted) {
      throw new TimeoutError(ms);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withTimeout, TimeoutError };
