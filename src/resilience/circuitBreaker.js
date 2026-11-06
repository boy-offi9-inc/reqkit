class CircuitOpenError extends Error {
  constructor(retryAfterMs) {
    super("Circuit is open — failing fast instead of calling a service that keeps failing");
    this.name = "CircuitOpenError";
    // Deliberately not an E-code: this is *not* a network error and must not be retried as one.
    this.code = "CIRCUIT_OPEN";
    this.retryAfterMs = retryAfterMs;
  }
}

function defaultIsFailure(valueOrError, isError) {
  if (isError) return !(valueOrError && valueOrError.name === "AbortError");
  return Boolean(valueOrError) && typeof valueOrError.status === "number" && valueOrError.status >= 500;
}

/**
 * Circuit breaker: after `failureThreshold` consecutive failures it "opens"
 * and fails fast with CircuitOpenError for `resetTimeoutMs`, so a dying
 * service isn't hammered (and your callers don't wait on it). Then it goes
 * "half-open" and lets `halfOpenMax` probe through: success closes the
 * circuit, failure re-opens it.
 *
 * By default a thrown error (except AbortError) or a result with status >= 500
 * counts as a failure; override with `isFailure(valueOrError, isError)`.
 *
 * @param {object} [opts]
 * @param {number} [opts.failureThreshold=5]
 * @param {number} [opts.resetTimeoutMs=30000]
 * @param {number} [opts.halfOpenMax=1]
 * @param {(valueOrError: any, isError: boolean) => boolean} [opts.isFailure]
 * @param {(state: string, prev: string) => void} [opts.onStateChange]
 */
function createCircuitBreaker(opts = {}) {
  const {
    failureThreshold = 5,
    resetTimeoutMs = 30000,
    halfOpenMax = 1,
    isFailure = defaultIsFailure,
    onStateChange,
  } = opts;

  let state = "closed";
  let failures = 0;
  let openedAt = 0;
  let probes = 0;

  function setState(next) {
    if (next === state) return;
    const prev = state;
    state = next;
    if (onStateChange) onStateChange(next, prev);
  }

  function open() {
    openedAt = Date.now();
    setState("open");
  }

  function current() {
    if (state === "open" && Date.now() - openedAt >= resetTimeoutMs) {
      probes = 0;
      setState("half-open");
    }
    return state;
  }

  function recordFailure() {
    if (state === "half-open") {
      open();
      return;
    }
    failures++;
    if (failures >= failureThreshold) open();
  }

  function recordSuccess() {
    failures = 0;
    if (state === "half-open") setState("closed");
  }

  async function run(fn) {
    const s = current();
    if (s === "open") {
      throw new CircuitOpenError(Math.max(0, resetTimeoutMs - (Date.now() - openedAt)));
    }
    let probing = false;
    if (s === "half-open") {
      if (probes >= halfOpenMax) throw new CircuitOpenError(0);
      probes++;
      probing = true;
    }

    let result;
    try {
      result = await fn();
    } catch (err) {
      if (isFailure(err, true)) recordFailure();
      else if (probing) probes--; // e.g. an abort — free the probe slot
      throw err;
    }

    if (isFailure(result, false)) recordFailure();
    else recordSuccess();
    return result;
  }

  return {
    run,
    get state() {
      return current();
    },
    get failures() {
      return failures;
    },
    /** Force the circuit closed and forget the failure count. */
    reset() {
      failures = 0;
      probes = 0;
      setState("closed");
    },
  };
}

module.exports = { createCircuitBreaker, CircuitOpenError };
