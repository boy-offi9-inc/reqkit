class TimeoutError extends Error {
  constructor(ms) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.code = "ETIMEDOUT";
  }
}

/**
 * Races an async function against a timeout. `fn` is handed an AbortSignal
 * so the underlying request can actually be cancelled (not just abandoned) —
 * e.g. `withTimeout(signal => fetch(url, { signal }), 5000)`.
 *
 * Pass your own `signal` to also cancel from the outside (user navigated
 * away, shutdown...). That signal is linked into the one `fn` receives, and
 * aborting it rejects with its reason even if `fn` ignores the signal.
 * `ms: Infinity` disables the timer (handy to only link a signal).
 *
 * @param {(signal: AbortSignal) => Promise<any>} fn
 * @param {number} ms
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - external cancellation
 */
async function withTimeout(fn, ms, opts = {}) {
  const { signal } = opts;

  if (typeof ms !== "number" || Number.isNaN(ms) || ms < 0) {
    throw new TypeError("withTimeout: `ms` must be a non-negative number (or Infinity)");
  }
  signal?.throwIfAborted?.();

  const controller = new AbortController();
  let timedOut = false;

  const timer =
    ms === Infinity
      ? null
      : setTimeout(() => {
          timedOut = true;
          controller.abort(new TimeoutError(ms));
        }, ms);

  const onExternalAbort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  const guard = new Promise((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(timedOut ? new TimeoutError(ms) : controller.signal.reason),
      { once: true }
    );
  });

  try {
    return await Promise.race([fn(controller.signal), guard]);
  } catch (err) {
    // If our timeout is what triggered the abort, always surface TimeoutError —
    // regardless of whether fn's own rejection or our guard "won" the race
    // (that's a listener-registration-order detail callers shouldn't have to
    // think about).
    if (timedOut) throw new TimeoutError(ms);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

module.exports = { withTimeout, TimeoutError };
