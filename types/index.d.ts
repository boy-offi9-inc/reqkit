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
  /**
   * `true` only learns from X-RateLimit-* / Retry-After headers; `{ requests, perMs }`
   * also enforces a budget; or share a createRateLimiter() instance.
   */
  rateLimit?: boolean | RateLimiterOptions | RateLimiter;
  /** Options for a per-origin breaker, a shared breaker instance, or `(url) => breaker`. */
  circuitBreaker?: boolean | CircuitBreakerOptions | CircuitBreaker | ((url: string) => CircuitBreaker);
  /**
   * Extra origins ("https://cdn.example.com") that may receive the default credentials
   * (`auth` and default Authorization/Cookie/X-API-Key headers), besides `baseUrl`'s.
   * Absolute URLs to any other origin don't get them. With neither `baseUrl` nor
   * `trustedOrigins` there's nothing to compare against and credentials go everywhere.
   */
  trustedOrigins?: string[];
  /** Attach a token and, on a 401, refresh it once (shared by all concurrent requests) and replay. */
  auth?: AuthOptions;
  /** In-memory GET cache with TTL, stale-while-revalidate and ETag/Last-Modified revalidation. `true` = 60s TTL. */
  cache?: boolean | CacheOptions;
  /** Merge identical concurrent GET/HEAD calls. Default false. */
  dedupe?: boolean;
  /** Throw HTTPError on non-2xx. Default true. */
  throwHttpErrors?: boolean;
  fetch?: typeof fetch;
  onRequest?: (ctx: FetchHookContext) => void | Promise<void>;
  onResponse?: (ctx: FetchHookContext & { response: Response }) => void | Promise<void>;
}

export interface ReqkitRequestInit extends Omit<RequestInit, "headers" | "cache"> {
  headers?: HeadersInit;
  query?: Record<string, unknown>;
  /** Serialized as the body with a JSON content-type. */
  json?: unknown;
  timeout?: number | false;
  retry?: false | CreateFetchRetryOptions;
  throwHttpErrors?: boolean;
  /** `false`/"no-store" bypass the cache; "reload" skips the read but refreshes the entry. */
  cache?: false | "no-store" | "reload";
}

export interface ReqkitFetch {
  (input: string, init?: ReqkitRequestInit): Promise<Response>;
  /** The `baseUrl` this instance was created with. */
  readonly baseUrl: string | undefined;
  /** Resolves to the parsed JSON body (null for an empty body). */
  json<T = unknown>(input: string, init?: ReqkitRequestInit): Promise<T>;
  /** New instance with these defaults merged over the current ones. */
  extend(overrides?: CreateFetchDefaults): ReqkitFetch;
}

export function createFetch(defaults?: CreateFetchDefaults): ReqkitFetch;

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

export interface CacheStore {
  get(key: string): any | Promise<any>;
  set(key: string, value: any): void | Promise<void>;
  delete(key: string): any;
}

export interface MemoryCache extends CacheStore {
  clear(): void;
  readonly size: number;
}

export function createMemoryCache(opts?: { maxEntries?: number }): MemoryCache;

export interface CacheEvent {
  type: "hit" | "stale" | "revalidated" | "miss" | "store";
  url: string;
}

export interface CacheOptions {
  /** How long an entry is served without asking the server, in ms. Default 60000. */
  ttl?: number;
  /** After the TTL, keep serving the stale copy for this long while refreshing in the background. Default 0. */
  staleWhileRevalidate?: number;
  /** For the built-in memory store. Default 100. */
  maxEntries?: number;
  /** Responses larger than this aren't cached. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Bring your own store (Redis, IndexedDB, a Map...). */
  store?: CacheStore;
  onEvent?: (event: CacheEvent) => void;
}

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
  signal?: AbortSignal;
  /** The body parsed as JSON, if it was a JSON string. */
  readonly json: any;
}

export interface MockReplyOptions {
  headers?: HeadersInit;
  /** Wait this long before answering; respects the request's AbortSignal. */
  delayMs?: number;
}

export interface MockRoute {
  reply(status?: number, body?: unknown, opts?: MockReplyOptions): MockRoute;
  replyOnce(status?: number, body?: unknown, opts?: MockReplyOptions): MockRoute;
  replyWith(fn: (call: MockCall) => Response | { status?: number; body?: unknown; headers?: HeadersInit } | Promise<Response | { status?: number; body?: unknown; headers?: HeadersInit }>): MockRoute;
  replyWithOnce(fn: (call: MockCall) => Response | { status?: number; body?: unknown; headers?: HeadersInit } | Promise<Response | { status?: number; body?: unknown; headers?: HeadersInit }>): MockRoute;
  fail(err?: unknown): MockRoute;
  failOnce(err?: unknown): MockRoute;
}

export type MockMatcher = string | RegExp | ((url: string) => boolean);

export interface MockFetch {
  fetch: typeof fetch;
  on(method: string, matcher: MockMatcher): MockRoute;
  get(matcher: MockMatcher): MockRoute;
  post(matcher: MockMatcher): MockRoute;
  put(matcher: MockMatcher): MockRoute;
  patch(matcher: MockMatcher): MockRoute;
  delete(matcher: MockMatcher): MockRoute;
  /** A TypeError("fetch failed") whose `cause.code` is set, like Node's fetch throws. */
  networkError(code?: string): TypeError;
  readonly calls: MockCall[];
  reset(): void;
}

export function createMockFetch(): MockFetch;

export interface DownloadResumableOptions {
  fetch?: typeof fetch;
  headers?: HeadersInit;
  /** Consecutive attempts without progress before giving up. Default 5. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
  /** Throws BodyTooLargeError past this many bytes. */
  maxBytes?: number;
  signal?: AbortSignal;
  onRetry?: (err: unknown, attempt: number, delayMs: number, info: { resumeFrom: number }) => void;
}

export function downloadResumable(url: string, opts?: DownloadResumableOptions): Promise<Uint8Array>;

export type StreamSource = Response | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;

export interface StreamOptions {
  signal?: AbortSignal;
  /**
   * Longest line (or, for readSSE, one event's data) in characters before throwing
   * `code: "LINE_TOO_LONG"` — protects against a server that never sends a newline.
   * Default 16 Mi (16 * 1024 * 1024); pass Infinity to disable.
   */
  maxLineLength?: number;
}

export interface SSEEvent {
  event: string;
  data: string;
  id: string;
  retry: number | undefined;
}

export function readLines(source: StreamSource, opts?: StreamOptions): AsyncGenerator<string, void, undefined>;
export function readNDJSON<T = unknown>(
  source: StreamSource,
  opts?: StreamOptions & { skipInvalid?: boolean }
): AsyncGenerator<T, void, undefined>;
export function readSSE(source: StreamSource, opts?: StreamOptions): AsyncGenerator<SSEEvent, void, undefined>;

export interface StreamSSEOptions {
  /** e.g. a createFetch() instance. Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Default "GET". Only GET/HEAD reconnect unless `reconnect: true`. */
  method?: string;
  /** A function is re-evaluated before every (re)connect — handy for refreshing a token. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  body?: BodyInit | null;
  signal?: AbortSignal;
  /** Resume from this id on the very first connect. */
  lastEventId?: string;
  /** Default: true for GET/HEAD, false otherwise. */
  reconnect?: boolean;
  /** Consecutive no-progress connection failures before giving up. Default 10 (Infinity = never). */
  retries?: number;
  /** Base reconnect delay; the server's `retry:` field overrides it. Default 1000. */
  reconnectDelayMs?: number;
  /** Cap on the exponential backoff. Default 30000. */
  maxDelayMs?: number;
  /** End the stream (no reconnect) after this event, e.g. `e => e.data === "[DONE]"`. */
  stopWhen?: (event: SSEEvent) => boolean;
  onOpen?: (info: { connections: number; lastEventId: string }) => void;
  onReconnect?: (info: {
    reason: "error" | "end" | "status";
    error?: unknown;
    status?: number;
    /** Consecutive reconnects without progress (at least 1). */
    attempt: number;
    delayMs: number;
    lastEventId: string;
  }) => void;
}

/** Auto-reconnecting SSE: resumes with Last-Event-ID, honors `retry:` and Retry-After. */
export function streamSSE(url: string, opts?: StreamSSEOptions): AsyncGenerator<SSEEvent, void, undefined>;

export interface AuthOptions {
  /** The current token (sync or async). Falsy = send no auth header. */
  getToken(): string | null | undefined | Promise<string | null | undefined>;
  /**
   * Called ONCE when requests are rejected (401 by default), no matter how many
   * are waiting. Return the new token, or update your store and return nothing
   * (reqkit then calls getToken() again). Throwing rejects every waiting request.
   */
  refresh(ctx: { token: string; response: Response }): string | void | undefined | Promise<string | void | undefined>;
  /** Default "authorization". */
  header?: string;
  /** Default "Bearer". Use "" to send the bare token (e.g. for an X-API-Key header). */
  scheme?: string;
  /** Default: `res.status === 401`. */
  shouldRefresh?: (response: Response) => boolean;
}

export interface PageContext {
  index: number;
  signal?: AbortSignal;
}

export interface PageResult<T, C = any> {
  items: T[];
  /** Whatever identifies the next page (token, offset, URL...). undefined/null = last page. */
  next?: C | null;
}

export interface Page<T, C = any> {
  items: T[];
  index: number;
  /** The cursor this page was fetched with (undefined for the first, unless `start` was given). */
  cursor: C | undefined;
}

export interface PaginateOptions<C = any> {
  /** The cursor for the first page. */
  start?: C;
  maxPages?: number;
  maxItems?: number;
  signal?: AbortSignal;
}

export type FetchPage<T, C = any> = (cursor: C | undefined, ctx: PageContext) => Promise<PageResult<T, C>>;

/** Yields every item, fetching pages lazily. */
export function paginate<T, C = any>(fetchPage: FetchPage<T, C>, opts?: PaginateOptions<C>): AsyncGenerator<T, void, undefined>;
/** Yields whole pages. */
export function paginatePages<T, C = any>(
  fetchPage: FetchPage<T, C>,
  opts?: Omit<PaginateOptions<C>, "maxItems">
): AsyncGenerator<Page<T, C>, void, undefined>;

export interface PaginateLinksOptions<T = any> {
  /** Default: the body if it's an array, else its `items` / `data` / `results` / `records`. */
  getItems?: (data: any, response: Response) => T[];
  maxPages?: number;
  maxItems?: number;
  signal?: AbortSignal;
  /** Extra options passed to every request. */
  init?: Record<string, any>;
  /**
   * Origins a `Link` may point to. Default: the origin of `url` (or of the createFetch
   * instance's `baseUrl`). Any other origin throws `code: "PAGINATE_CROSS_ORIGIN"`.
   */
  origins?: string[];
}

/** Follows `Link: <...>; rel="next"` headers and yields the items of every page. */
export function paginateLinks<T = any>(
  request: (url: string, init?: any) => Promise<Response>,
  url: string,
  opts?: PaginateLinksOptions<T>
): AsyncGenerator<T, void, undefined>;

/** Parses an RFC 8288 Link header into `{ rel: url }`. Pass `base` to resolve relative URLs. */
export function parseLinkHeader(header: string | null | undefined, base?: string): Record<string, string>;
