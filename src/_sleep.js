class RetryAbortedError extends Error {
  constructor(cause) {
    super("Retry loop was aborted");
    this.name = "RetryAbortedError";
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Abortable sleep shared by withRetry and retryAfterAware. Rejects with
 * RetryAbortedError (carrying `cause`, usually the last failure) if the
 * signal aborts before or during the wait.
 */
function sleep(ms, signal, cause) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortedError(cause));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RetryAbortedError(cause));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Like sleep(), but rejects with the signal's own reason (an AbortError by default). */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

module.exports = { RetryAbortedError, sleep, abortableSleep };
