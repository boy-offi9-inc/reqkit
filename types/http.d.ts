// createFetch and the request/response helpers — src/http/
import type { CircuitBreaker, CircuitBreakerOptions, CircuitState, RateLimiter, RateLimiterOptions, RetryOptions } from "./resilience";

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
  /**
   * Send a backup request when an attempt is slow and take whichever answers first
   * (idempotent methods, or requests with an Idempotency-Key). `true` = delayMs "auto".
   */
  hedge?: boolean | HedgeConfig;
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
  /** One callback for everything that happens. Errors thrown by the handler are ignored. */
  onEvent?: (event: FetchEvent) => void | Promise<void>;
}

export interface ReqkitRequestInit extends Omit<RequestInit, "headers" | "cache"> {
  headers?: HeadersInit;
  query?: Record<string, unknown>;
  /** Serialized as the body with a JSON content-type. */
  json?: unknown;
  timeout?: number | false;
  retry?: false | CreateFetchRetryOptions;
  throwHttpErrors?: boolean;
  /** `false` disables hedging for this call; an object overrides the defaults. */
  hedge?: boolean | HedgeConfig;
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

export interface HedgeConfig {
  /** Milliseconds before a backup is sent, or "auto" (default) to use your own recent latency. */
  delayMs?: number | "auto";
  /** Backups per attempt. Default 1. */
  maxHedges?: number;
  /** Methods that may be hedged. Default: the idempotent ones (GET, HEAD, OPTIONS, PUT, DELETE). */
  methods?: string[];
  /** For "auto": which percentile of recent latency to wait for. Default 0.95. */
  percentile?: number;
  /** For "auto": never hedge sooner than this. Default 20. */
  minDelayMs?: number;
  /** For "auto": the delay used until `minSamples` responses were seen. Default 300. */
  fallbackDelayMs?: number;
  /** For "auto": samples needed before trusting the percentile. Default 10. */
  minSamples?: number;
}

export interface CacheEvent {
  type: "hit" | "stale" | "revalidated" | "miss" | "store" | "stale-if-error";
  url: string;
}

export interface CacheOptions {
  /** How long an entry is served without asking the server, in ms. Default 60000. */
  ttl?: number;
  /** After the TTL, keep serving the stale copy for this long while refreshing in the background. Default 0. */
  staleWhileRevalidate?: number;
  /**
   * How long past the TTL a cached copy may still be served when the origin is failing
   * (network error, timeout, open circuit, or a 5xx). 4xx responses and aborts are never masked. Default 0 (off).
   */
  staleIfError?: number;
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

/** Events delivered to `createFetch({ onEvent })`. */
export type FetchEvent =
  | { type: "request"; url: string; method: string }
  | { type: "attempt"; url: string; method: string; /** 1-based */ attempt: number }
  | {
      type: "retry";
      url: string;
      method: string;
      /** The attempt that failed (1-based). */
      attempt: number;
      delayMs: number;
      reason: "error" | "status";
      status?: number;
      error?: unknown;
    }
  | {
      type: "response";
      url: string;
      method: string;
      status: number;
      ok: boolean;
      durationMs: number;
      /** Network attempts made (0 for a cache hit). */
      attempts: number;
      /** How the cache was involved, if it was. */
      cache?: "hit" | "stale" | "revalidated" | "miss" | "stale-if-error";
      /** Backup requests sent for this call. */
      hedges: number;
      /** True when a backup request produced the response. */
      hedgeWon: boolean;
    }
  | { type: "error"; url?: string; method?: string; error: unknown; durationMs: number; attempts: number; hedges: number }
  | { type: "hedge"; url: string; method: string; /** 1-based backup number */ index: number; /** ms since the call's attempt began */ afterMs: number }
  | { type: "cache"; url: string; method: "GET"; event: CacheEvent["type"] }
  | { type: "ratelimit"; url: string; method: string; waitedMs: number }
  | { type: "circuit"; origin: string; state: CircuitState; previous: CircuitState }
  | { type: "auth"; url: string; method: string; outcome: "refreshed" | "reused" | "failed"; error?: unknown };
