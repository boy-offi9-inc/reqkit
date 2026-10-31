export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
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

export function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T>;

export interface NormalizedError {
  message: string;
  status: number | null;
  code: string | null;
  isNetworkError: boolean;
  isTimeout: boolean;
  /** True when the request was cancelled on purpose (AbortController, axios cancel). */
  isAborted: boolean;
  cause: unknown;
}

export function normalizeError(err: unknown): NormalizedError;

export interface JsonSafeResult<T = unknown> {
  data: T | null;
  error: Error | null;
}

export function parseJsonSafe<T = unknown>(input: Response | string): Promise<JsonSafeResult<T>>;

export function buildQuery(params: Record<string, unknown> | null | undefined): string;

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

export interface DownloadProgress {
  loaded: number;
  total: number | null;
  percent: number | null;
}

export interface WithProgressOptions {
  /** Reject with BodyTooLargeError once more than this many bytes arrive. */
  maxBytes?: number;
  /** Cancels the read; rejects with the signal's reason. */
  signal?: AbortSignal;
}

export class BodyTooLargeError extends Error {
  name: "BodyTooLargeError";
  code: "EBODYTOOLARGE";
  maxBytes: number;
  constructor(maxBytes: number);
}

export function withProgress(
  response: Response,
  onProgress?: (progress: DownloadProgress) => void,
  opts?: WithProgressOptions
): Promise<Uint8Array>;

export interface DedupeOptions {
  keyFn?: (...args: any[]) => string;
}

export function withDedupe<Fn extends (...args: any[]) => Promise<any>>(
  fn: Fn,
  opts?: DedupeOptions
): Fn;
