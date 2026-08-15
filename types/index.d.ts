export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
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

export function withProgress(
  response: Response,
  onProgress?: (progress: DownloadProgress) => void
): Promise<Uint8Array>;
