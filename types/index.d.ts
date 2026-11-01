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

export interface Limiter {
  <A extends any[], R>(fn: (...args: A) => R | Promise<R>, ...args: A): Promise<R>;
  readonly activeCount: number;
  readonly pendingCount: number;
  /** Runs fn(item, index) for each item through the limiter; keeps input order. */
  map<T, R>(items: Iterable<T>, fn: (item: T, index: number) => R | Promise<R>): Promise<R[]>;
}

export function createLimiter(concurrency?: number): Limiter;

export class HTTPError extends Error {
  name: "HTTPError";
  status: number;
  statusText: string;
  response: Response;
  url: string;
  method: string;
  constructor(response: Response, request: { method: string; url: string });
}

export interface CreateFetchRetryOptions {
  /** Default 2. */
  retries?: number;
  /** Default [408, 425, 429, 500, 502, 503, 504]. */
  statusCodes?: number[];
  /** Methods that may be retried. Default GET, HEAD, OPTIONS, PUT, DELETE. */
  methods?: string[];
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: number | "full";
  maxRetryTime?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  calculateDelay?: RetryOptions["calculateDelay"];
  onRetry?: RetryOptions["onRetry"];
}

export interface FetchHookContext {
  url: string;
  init: RequestInit & { headers: Headers };
}

export interface CreateFetchDefaults {
  baseUrl?: string;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Per attempt, in ms. false disables. Default 30000. */
  timeout?: number | false;
  /** false disables retrying. */
  retry?: false | CreateFetchRetryOptions;
  /** Merge identical concurrent GET/HEAD calls. Default false. */
  dedupe?: boolean;
  /** Throw HTTPError on non-2xx. Default true. */
  throwHttpErrors?: boolean;
  fetch?: typeof fetch;
  onRequest?: (ctx: FetchHookContext) => void | Promise<void>;
  onResponse?: (ctx: FetchHookContext & { response: Response }) => void | Promise<void>;
}

export interface ReqkitRequestInit extends Omit<RequestInit, "headers"> {
  headers?: HeadersInit;
  query?: Record<string, unknown>;
  /** Serialized as the body with a JSON content-type. */
  json?: unknown;
  timeout?: number | false;
  retry?: false | CreateFetchRetryOptions;
  throwHttpErrors?: boolean;
}

export interface ReqkitFetch {
  (input: string, init?: ReqkitRequestInit): Promise<Response>;
  /** Resolves to the parsed JSON body (null for an empty body). */
  json<T = unknown>(input: string, init?: ReqkitRequestInit): Promise<T>;
  /** New instance with these defaults merged over the current ones. */
  extend(overrides?: CreateFetchDefaults): ReqkitFetch;
}

export function createFetch(defaults?: CreateFetchDefaults): ReqkitFetch;
