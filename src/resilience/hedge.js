const { discardBody } = require("../internal/http");

function defaultIsFailure(result) {
  return Boolean(result) && typeof result.status === "number" && result.status >= 500;
}

function lostReason() {
  const reason = new Error("Request cancelled: a faster hedged request won");
  reason.name = "AbortError";
  return reason;
}

/**
 * Hedged requests: start `fn`; if it hasn't answered within `delayMs`, start
 * a backup (a "hedge"); whichever succeeds first wins and the others are
 * aborted. It trims the slow tail of latency — the occasional request that
 * takes 10× longer than the rest — at the cost of a little extra load.
 *
 * ```js
 * const res = await withHedge((signal) => fetch(url, { signal }), { delayMs: 200 });
 * ```
 *
 * Only hedge requests that are safe to run twice (GETs, idempotent calls).
 *
 * Details:
 *  - `fn(signal, index)` — `index` is 0 for the original and 1.. for backups.
 *    Abort-aware code (like `fetch`) is actually cancelled when it loses.
 *  - An attempt that throws, or returns a failed result (status >= 500 by
 *    default), launches the next backup immediately instead of waiting.
 *  - If every attempt fails: resolves with the last failed *result* if there was
 *    one (a 503 `Response` isn't thrown), otherwise rejects with the last error.
 *  - The bodies of responses that lose are cancelled so connections are freed.
 *
 * @template T
 * @param {(signal: AbortSignal, index: number) => Promise<T>} fn
 * @param {object} opts
 * @param {number | ((index: number) => number)} opts.delayMs - wait before launching backup #index (1-based)
 * @param {number} [opts.maxHedges=1] - how many backups at most
 * @param {(result: T) => boolean} [opts.isFailure] - results that count as failed. Default: `result.status >= 500`
 * @param {boolean} [opts.hedgeOnError=true] - launch the next backup right away when an attempt throws
 * @param {(info: { index: number, afterMs: number }) => void} [opts.onHedge] - a backup was launched
 * @param {(index: number) => void} [opts.onWinner] - which attempt produced the result (0 = the original)
 * @param {AbortSignal} [opts.signal] - cancels everything; rejects with the signal's reason
 * @returns {Promise<T>}
 */
function withHedge(fn, opts = {}) {
  const { delayMs, maxHedges = 1, isFailure = defaultIsFailure, hedgeOnError = true, onHedge, onWinner, signal } = opts;

  const delayFor = typeof delayMs === "function" ? delayMs : () => delayMs;
  if (typeof delayMs !== "function" && !(typeof delayMs === "number" && delayMs >= 0 && Number.isFinite(delayMs))) {
    return Promise.reject(new TypeError("withHedge: `delayMs` must be a non-negative number or a function returning one"));
  }
  if (!(Number.isInteger(maxHedges) && maxHedges >= 0)) {
    return Promise.reject(new TypeError("withHedge: `maxHedges` must be an integer >= 0"));
  }
  if (signal && signal.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const attempts = []; // { controller, done }
    let launched = 0;
    let pending = 0;
    let settled = false;
    let timer = null;
    let lastError;
    let hasError = false;
    let failedResult;
    let hasFailedResult = false;

    const onAbort = () => finish(reject, signal.reason, -1);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    function finish(settle, value, winnerIndex) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      attempts.forEach((attempt, index) => {
        if (index !== winnerIndex && !attempt.done) attempt.controller.abort(lostReason());
      });
      if (hasFailedResult && failedResult !== value) discardBody(failedResult);
      if (winnerIndex >= 0 && onWinner) {
        try {
          onWinner(winnerIndex);
        } catch {
          // ignore
        }
      }
      settle(value);
    }

    function scheduleBackup() {
      clearTimeout(timer);
      if (launched > maxHedges) return; // `launched` counts the original too
      timer = setTimeout(() => launch(), Math.max(0, Number(delayFor(launched)) || 0));
    }

    function launch() {
      if (settled) return;
      const index = launched++;
      const controller = new AbortController();
      const attempt = { controller, done: false };
      attempts[index] = attempt;
      pending++;

      if (index > 0 && onHedge) {
        try {
          onHedge({ index, afterMs: Date.now() - startedAt });
        } catch {
          // ignore
        }
      }

      let promise;
      try {
        promise = Promise.resolve(fn(controller.signal, index));
      } catch (error) {
        promise = Promise.reject(error);
      }

      promise.then(
        (result) => {
          attempt.done = true;
          pending--;
          if (settled) return discardBody(result); // too late — it lost
          if (isFailure(result)) {
            if (hasFailedResult) discardBody(failedResult);
            failedResult = result;
            hasFailedResult = true;
            return next();
          }
          finish(resolve, result, index);
        },
        (error) => {
          attempt.done = true;
          pending--;
          if (settled) return;
          lastError = error;
          hasError = true;
          if (hedgeOnError) next();
          else if (pending === 0 && launched > maxHedges) giveUp();
        }
      );

      scheduleBackup();
    }

    // An attempt failed: start the next backup now, or give up if there are none left.
    function next() {
      if (settled) return;
      if (launched <= maxHedges) {
        clearTimeout(timer);
        launch();
      } else if (pending === 0) {
        giveUp();
      }
    }

    function giveUp() {
      if (hasFailedResult) finish(resolve, failedResult, -1);
      else finish(reject, hasError ? lastError : new Error("withHedge: no attempt succeeded"), -1);
    }

    launch();
  });
}

module.exports = { withHedge };
