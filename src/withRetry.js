function defaultShouldRetry(err) {
  // Retry network-level failures by default. HTTP status handling is the
  // caller's job (they know what "failure" means for their response shape) —
  // see retryAfterAware.js for a version that understands status codes.
  return Boolean(err) && err.name !== "AbortError";
}

class RetryAbortedError extends Error {
  constructor() {
    super("Retry loop was aborted");
    this.name = "RetryAbortedError";
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortedError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new RetryAbortedError());
        },
        { once: true }
      );
    }
  });
}

/**
 * Retries an async function with exponential backoff + jitter.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries=3] - max retry attempts after the first try
 * @param {number} [opts.baseDelayMs=300] - initial delay
 * @param {number} [opts.maxDelayMs=10000] - delay ceiling
 * @param {(err: any, attempt: number) => boolean} [opts.shouldRetry]
 * @param {(err: any, attempt: number, delayMs: number) => void} [opts.onRetry]
 * @param {AbortSignal} [opts.signal] - cancels the whole retry loop,
 *   including any pending backoff wait, throwing RetryAbortedError. This is
 *   separate from a per-call AbortSignal you might pass into `fn` yourself —
 *   this one governs whether *another attempt starts at all*.
 */
async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 300,
    maxDelayMs = 10000,
    shouldRetry = defaultShouldRetry,
    onRetry,
    signal,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      throw new RetryAbortedError();
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === retries;
      if (isLastAttempt || !shouldRetry(err, attempt)) {
        throw err;
      }
      const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = Math.random() * exponential * 0.2;
      const waitMs = Math.round(exponential + jitter);
      if (onRetry) onRetry(err, attempt, waitMs);
      await delay(waitMs, signal);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, RetryAbortedError };
