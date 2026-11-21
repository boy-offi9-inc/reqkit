const { RetryAbortedError, sleep } = require("../internal/sleep");
const { getWaitMsFromHeaders, discardBody } = require("../internal/http");

function defaultShouldRetry(err) {
  // Retry thrown errors except deliberate aborts. Narrow it with `shouldRetry`
  // (e.g. network errors only). HTTP *statuses* aren't errors with fetch, so
  // opt in with `retryStatusCodes` / `shouldRetryResult`.
  return Boolean(err) && err.name !== "AbortError";
}

/**
 * Throw this from inside `fn` to stop retrying immediately. If you pass an
 * Error, that exact error is what withRetry rethrows; with a string, the
 * StopRetry itself is thrown. (Same idea as p-retry's AbortError.)
 */
class StopRetry extends Error {
  constructor(reasonOrMessage) {
    const isError = reasonOrMessage instanceof Error;
    super(isError ? reasonOrMessage.message : String(reasonOrMessage ?? "Retrying was stopped"));
    this.name = "StopRetry";
    this.original = isError ? reasonOrMessage : null;
  }
}

/**
 * Retries an async function with exponential backoff + jitter. Retries on
 * thrown errors, and — opt-in — on *results* too (HTTP status codes, or any
 * predicate), honoring Retry-After / X-RateLimit-Reset when the result has
 * headers.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries=3] - max retry attempts after the first try (Infinity is fine with maxRetryTime)
 * @param {number} [opts.baseDelayMs=300] - initial delay
 * @param {number} [opts.maxDelayMs=10000] - backoff ceiling
 * @param {number} [opts.factor=2] - backoff multiplier
 * @param {number|"full"} [opts.jitter=0.2] - fraction of extra random delay
 *   added on top (0 disables); "full" picks uniformly in [0, delay] — the
 *   AWS "full jitter" strategy, best when many clients retry at once
 * @param {number} [opts.maxRetryTime=Infinity] - total time budget in ms
 *   across all attempts and waits; once the next wait would blow it, stop
 *   and surface the last error/result
 * @param {number} [opts.totalDeadlineMs=Infinity] - hard deadline in ms from
 *   the start of the loop that covers EVERYTHING: in-flight attempts, backoff
 *   waits and Retry-After waits alike. When it expires, the in-flight `fn`
 *   is aborted via `opts.fnSignal` (if provided) and the loop settles with
 *   `DeadlineError` (or the caller signal's reason). Unlike `maxRetryTime`,
 *   which only checks before scheduling a wait, this is enforced *while*
 *   waiting and while an attempt is in flight, so no dispatch can start —
 *   and no attempt can outlive — the deadline.
 * @param {(err: any, attempt: number) => boolean} [opts.shouldRetry] - for thrown errors
 * @param {number[]} [opts.retryStatusCodes=[]] - retry when the result's `.status` is in this list
 * @param {(result: any, attempt: number) => boolean} [opts.shouldRetryResult] - retry on any result predicate
 * @param {boolean} [opts.respectRetryAfter=true] - use Retry-After/X-RateLimit-Reset from `result.headers`
 * @param {number} [opts.maxRetryAfterMs=60000] - cap on a header-provided wait
 * @param {(info: {attempt: number, error: any, result: any, delayMs: number}) => number|false} [opts.calculateDelay]
 *   - override the wait; return a number of ms, or false to stop retrying
 * @param {(err: any, attempt: number, delayMs: number, ctx: {reason: "error"|"result", result?: any, status?: number}) => void} [opts.onRetry]
 *   - `err` is undefined when the retry was triggered by a result
 * @param {AbortSignal} [opts.signal] - cancels the whole retry loop,
 *   including any pending backoff wait, throwing RetryAbortedError (with the
 *   last failure as `cause`). Separate from a per-call signal you pass into
 *   `fn` yourself — this one governs whether *another attempt starts at all*.
 * @param {AbortSignal} [opts.fnSignal] - the signal `fn` itself observes
 *   (the per-attempt signal). When `totalDeadlineMs` expires, this signal is
 *   aborted so the in-flight attempt is actually cancelled, not abandoned.
 */
class DeadlineError extends Error {
  constructor(ms) {
    super(`Retry loop exceeded its ${ms}ms total deadline`);
    this.name = "DeadlineError";
    this.code = "EDEADLINE";
    this.deadlineMs = ms;
  }
}

async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 300,
    maxDelayMs = 10000,
    factor = 2,
    jitter = 0.2,
    maxRetryTime = Infinity,
    totalDeadlineMs = Infinity,
    fnSignal,
    shouldRetry = defaultShouldRetry,
    retryStatusCodes = [],
    shouldRetryResult,
    respectRetryAfter = true,
    maxRetryAfterMs = 60000,
    calculateDelay,
    onRetry,
    signal,
  } = opts;

  const startedAt = Date.now();
  const deadlineAt = totalDeadlineMs === Infinity ? Infinity : startedAt + totalDeadlineMs;
  // The deadline shares plumbing with the caller signal: build an internal
  // controller and link the caller's signal into it, so every wait and gate
  // below reacts to whichever arrives first. Aborting that controller is what
  // stops dispatches and interrupts waits; when the caller also derives the
  // per-attempt signal from their own `signal` (the createFetch pattern), the
  // in-flight attempt is cancelled by the deadline through that link.
  let loopSignal = signal;
  let deadlineTimer = null;
  if (deadlineAt !== Infinity) {
    const deadlineController = new AbortController();
    deadlineTimer = setTimeout(
      () => deadlineController.abort(new DeadlineError(totalDeadlineMs)),
      totalDeadlineMs
    );
    if (signal) {
      if (signal.aborted) deadlineController.abort(signal.reason);
      else signal.addEventListener("abort", () => deadlineController.abort(signal.reason), { once: true });
    }
    loopSignal = deadlineController.signal;
  }

  function backoff(attempt) {
    const exponential = Math.min(baseDelayMs * factor ** attempt, maxDelayMs);
    if (jitter === "full") return Math.round(Math.random() * exponential);
    const extra = Math.random() * exponential * (Number(jitter) || 0);
    return Math.round(exponential + extra);
  }

  // Returns the wait in ms, or null if retrying should stop (custom
  // calculateDelay said so, or the time budget would be exceeded).
  function planWait(defaultMs, attempt, error, result) {
    let waitMs = defaultMs;
    if (calculateDelay) {
      const custom = calculateDelay({ attempt, error, result, delayMs: defaultMs });
      if (custom === false || custom === null || custom === undefined) return null;
      waitMs = Math.max(0, Number(custom) || 0);
    }
    if (Date.now() - startedAt + waitMs > maxRetryTime) return null;
    return waitMs;
  }

  function wantsResultRetry(result, attempt) {
    if (
      retryStatusCodes.length > 0 &&
      result &&
      typeof result.status === "number" &&
      retryStatusCodes.includes(result.status)
    ) {
      return true;
    }
    return shouldRetryResult ? Boolean(shouldRetryResult(result, attempt)) : false;
  }

  let lastErr;
  try {
    for (let attempt = 0; ; attempt++) {
      if (loopSignal?.aborted) {
        throwReasonOr(loopSignal.reason, new RetryAbortedError(lastErr));
      }

      let result;
      try {
        result = deadlineAt === Infinity
          ? await fn(attempt)
          : await Promise.race([
              fn(attempt),
              // The deadline bounds the CALLER's promise, not just dispatches:
              // if the attempt is still in flight (or the fn ignores signals),
              // the caller settles with DeadlineError at the deadline and the
              // abandoned attempt's eventual outcome is discarded. Cooperative
              // fn implementations (they observe the signal createFetch wires
              // in) are genuinely cancelled; uncooperative ones are abandoned.
              new Promise((_, reject) => {
                const onDeadline = () => reject(loopSignal.reason);
                if (loopSignal.aborted) onDeadline();
                else loopSignal.addEventListener("abort", onDeadline, { once: true });
              }),
            ]);
      } catch (err) {
        // A deadline abort during an attempt is terminal — never retried.
        if (loopSignal?.aborted) {
          throwReasonOr(loopSignal.reason, new RetryAbortedError(err));
        }
        if (err instanceof StopRetry) throw err.original ?? err;
        lastErr = err;
        if (attempt >= retries || !shouldRetry(err, attempt)) throw err;

        const waitMs = planWait(backoff(attempt), attempt, err, undefined);
        if (waitMs === null) throw err;

        if (onRetry) onRetry(err, attempt, waitMs, { reason: "error" });
        await sleep(waitMs, loopSignal, err).catch((sleepErr) => {
          // A deadline abort landing during this wait surfaces as DeadlineError;
          // a caller abort stays RetryAbortedError (with the failure as cause).
          if (loopSignal?.aborted) throwReasonOr(loopSignal.reason, sleepErr);
          throw sleepErr;
        });
        continue;
      }

      if (attempt >= retries || !wantsResultRetry(result, attempt)) return result;

      let defaultMs = backoff(attempt);
      if (respectRetryAfter) {
        const headerMs = getWaitMsFromHeaders(result && result.headers);
        if (headerMs !== null) defaultMs = Math.min(headerMs, maxRetryAfterMs);
      }
      const waitMs = planWait(defaultMs, attempt, undefined, result);
      if (waitMs === null) return result;

      await discardBody(result);
      if (onRetry) onRetry(undefined, attempt, waitMs, { reason: "result", result, status: result && result.status });
      await sleep(waitMs, loopSignal).catch((sleepErr) => {
        if (loopSignal?.aborted) throwReasonOr(loopSignal.reason, sleepErr);
        throw sleepErr;
      });
    }
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

// The loop's terminal error: a caller abort surfaces as the caller's own
// reason (plain AbortError); a deadline surfaces as DeadlineError.
function throwReasonOr(reason, fallback) {
  if (reason !== undefined && reason !== null && reason.name === "DeadlineError") throw reason;
  if (reason !== undefined && reason !== null && reason.name !== "AbortError") {
    // A caller-provided custom reason (any Error) wins over retry internals.
    if (reason instanceof Error && reason.name !== "DeadlineError") throw reason;
  }
  throw fallback;
}

module.exports = { withRetry, RetryAbortedError, StopRetry, DeadlineError };
