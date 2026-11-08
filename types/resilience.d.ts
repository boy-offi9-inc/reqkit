// Retry, timeout, dedupe, limiters and the circuit breaker — src/resilience/

export interface RetryContext {
  reason: "error" | "result";
  /** The result that triggered the retry (reason "result"). */
  result?: unknown;
  /** The result's HTTP status (reason "result"). */
  status?: number;
}

export interface CalculateDelayInfo {
  attempt: number;
  error: unknown;
  result: unknown;
  /** The delay reqkit would have used. */
  delayMs: number;
}

export interface RetryOptions {
  /** Max retries after the first try. Infinity is fine together with maxRetryTime. Default 3. */
  retries?: number;
  /** Default 300. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 10000. */
  maxDelayMs?: number;
  /** Backoff multiplier. Default 2. */
  factor?: number;
  /** Extra random fraction (default 0.2), or "full" for uniform [0, delay]. */
  jitter?: number | "full";
  /** Total time budget across attempts and waits, in ms. */
  maxRetryTime?: number;
  /** For thrown errors. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Retry when the result's `.status` is in this list. */
  retryStatusCodes?: number[];
  /** Retry on any result predicate. */
  shouldRetryResult?: (result: any, attempt: number) => boolean;
  /** Use Retry-After / X-RateLimit-Reset from `result.headers`. Default true. */
  respectRetryAfter?: boolean;
  /** Cap on a header-provided wait. Default 60000. */
  maxRetryAfterMs?: number;
  /** Return ms to wait, or false to stop retrying. */
  calculateDelay?: (info: CalculateDelayInfo) => number | false | null | undefined;
  /** `err` is undefined when a result (not an error) triggered the retry. */
  onRetry?: (err: unknown, attempt: number, delayMs: number, ctx: RetryContext) => void;
  signal?: AbortSignal;
}

/** Throw inside `fn` to stop retrying. An Error argument is rethrown as-is. */
export class StopRetry extends Error {
  name: "StopRetry";
  original: Error | null;
  constructor(reasonOrMessage?: unknown);
}

export class RetryAbortedError extends Error {
  name: "RetryAbortedError";
  /** The last failure before the loop was aborted, if there was one. */
  cause?: unknown;
}

export function withRetry<T>(fn: (attempt: number) => Promise<T>, opts?: RetryOptions): Promise<T>;

export class TimeoutError extends Error {
  code: "ETIMEDOUT";
  constructor(ms: number);
}

export interface TimeoutOptions {
  /** External cancellation, linked into the signal `fn` receives. */
  signal?: AbortSignal;
}

/** `ms` may be Infinity to disable the timer (only link `signal`). */
export function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  opts?: TimeoutOptions
): Promise<T>;

export interface RetryAfterAwareOptions {
  retries?: number;
  retryStatusCodes?: number[];
  fallbackDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (status: number, waitMs: number, attempt: number) => void;
  /** Decide whether a thrown error is retried. Default: network errors and timeouts only. */
  shouldRetryError?: (err: unknown, attempt: number) => boolean;
  onRetryError?: (err: unknown, waitMs: number, attempt: number) => void;
  /** Cancels the retry loop, including any pending wait. Throws RetryAbortedError. */
  signal?: AbortSignal;
}

export function retryAfterAware(
  fn: (attempt: number) => Promise<Response>,
  opts?: RetryAfterAwareOptions
): Promise<Response>;

export function parseRetryAfter(headerValue: string | null): number | null;
export function getWaitMsFromHeaders(headers: Headers | null | undefined): number | null;

export interface DedupeOptions {
  keyFn?: (...args: any[]) => string;
}

export function withDedupe<Fn extends (...args: any[]) => Promise<any>>(
  fn: Fn,
  opts?: DedupeOptions
): Fn;

export interface Limiter {
  <A extends any[], R>(fn: (...args: A) => R | Promise<R>, ...args: A): Promise<R>;
  readonly activeCount: number;
  readonly pendingCount: number;
  /** Runs fn(item, index) for each item through the limiter; keeps input order. */
  map<T, R>(items: Iterable<T>, fn: (item: T, index: number) => R | Promise<R>): Promise<R[]>;
}

export function createLimiter(concurrency?: number): Limiter;

export interface RateLimiterOptions {
  /** Max requests per window. Default Infinity. */
  requests?: number;
  /** Window length in ms. Default 1000. */
  perMs?: number;
}

export interface RateLimiter {
  /** Resolves when it's your turn (FIFO). Rejects with the signal's reason if aborted while waiting. */
  acquire(opts?: { signal?: AbortSignal }): Promise<void>;
  /** Learn from a response's X-RateLimit-* / RateLimit-* / Retry-After headers. */
  update(response: { status?: number; headers?: { get(name: string): string | null } } | null | undefined): void;
  /** acquire → fn() → update(result). */
  run<T>(fn: () => Promise<T>, opts?: { signal?: AbortSignal }): Promise<T>;
  /** Ms until a server-imposed pause ends (0 if none). */
  readonly blockedForMs: number;
  reset(): void;
}

export function createRateLimiter(opts?: RateLimiterOptions): RateLimiter;

export class CircuitOpenError extends Error {
  name: "CircuitOpenError";
  code: "CIRCUIT_OPEN";
  /** Ms until the breaker will let a probe through. */
  retryAfterMs: number;
  constructor(retryAfterMs: number);
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. Default 5. */
  failureThreshold?: number;
  /** How long to stay open before allowing a probe. Default 30000. */
  resetTimeoutMs?: number;
  /** Concurrent probes allowed while half-open. Default 1. */
  halfOpenMax?: number;
  /** Default: any thrown error except AbortError, or a result with status >= 500. */
  isFailure?: (valueOrError: any, isError: boolean) => boolean;
  onStateChange?: (state: CircuitState, previous: CircuitState) => void;
}

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreaker {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly state: CircuitState;
  readonly failures: number;
  reset(): void;
}

export function createCircuitBreaker(opts?: CircuitBreakerOptions): CircuitBreaker;

export interface HedgeOptions<T = any> {
  /** Wait before launching backup #index (1-based): a number of ms, or a function of the index. */
  delayMs: number | ((index: number) => number);
  /** How many backups at most. Default 1. */
  maxHedges?: number;
  /** Results that count as failed (and launch the next backup at once). Default: `result.status >= 500`. */
  isFailure?: (result: T) => boolean;
  /** Launch the next backup immediately when an attempt throws. Default true. */
  hedgeOnError?: boolean;
  /** A backup was launched. */
  onHedge?: (info: { index: number; afterMs: number }) => void;
  /** Which attempt produced the result (0 = the original). */
  onWinner?: (index: number) => void;
  /** Cancels everything; rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Hedged requests: if `fn` hasn't answered after `delayMs`, start a backup and take whichever
 * succeeds first; the others are aborted. Only hedge calls that are safe to run twice.
 */
export function withHedge<T>(fn: (signal: AbortSignal, index: number) => Promise<T> | T, opts: HedgeOptions<T>): Promise<T>;
