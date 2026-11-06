// createFetch and the request/response helpers — src/http/
import type { CircuitBreaker, CircuitBreakerOptions, RateLimiter, RateLimiterOptions, RetryOptions } from "./resilience";

export interface JsonSafeResult<T = unknown> {
  data: T | null;
  error: Error | null;
}

export function parseJsonSafe<T = unknown>(input: Response | string): Promise<JsonSafeResult<T>>;

export function buildQuery(params: Record<string, unknown> | null | undefined): string;

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
