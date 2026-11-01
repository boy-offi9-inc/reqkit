const { RetryAbortedError, sleep } = require("./_sleep");
const { getWaitMsFromHeaders, discardBody } = require("./_http");

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
 */
async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 300,
    maxDelayMs = 10000,
    factor = 2,
    jitter = 0.2,
    maxRetryTime = Infinity,
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
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) {
      throw new RetryAbortedError(lastErr);
    }

    let result;
    try {
      result = await fn(attempt);
    } catch (err) {
      if (err instanceof StopRetry) throw err.original ?? err;
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err, attempt)) throw err;

      const waitMs = planWait(backoff(attempt), attempt, err, undefined);
      if (waitMs === null) throw err;

      if (onRetry) onRetry(err, attempt, waitMs, { reason: "error" });
      await sleep(waitMs, signal, err);
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
    await sleep(waitMs, signal);
  }
}

module.exports = { withRetry, RetryAbortedError, StopRetry };
