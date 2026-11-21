// SSRF guard types (opt-in via createFetch `ssrfGuard` option, or standalone).

export declare class SSRFBlockedError extends Error {
  readonly name: "SSRFBlockedError";
  readonly code: "SSRF_BLOCKED";
  /** Why the request was blocked: "private-address", "resolves-to-private-address", "scheme-file", "too-many-redirects", "unparseable-url". */
  readonly reason: string;
  readonly url: string;
}

export interface SsrfGuardOptions {
  /** Master bypass (dev environments). Default: false. */
  allowPrivate?: boolean;
  /** Exact hostnames to allow even if they resolve private (e.g. ["localhost"] in dev). */
  allowHosts?: string[];
  /** Redirect hops followed while re-checking every target. Default: 5. */
  maxRedirects?: number;
}

export interface SsrfGuard {
  assertUrlAllowed(url: string): void;
  assertResolvableAllowed(url: string): Promise<void>;
  guardedFetch(fetchImpl: typeof fetch): typeof fetch;
}

export declare function createSsrfGuard(opts?: SsrfGuardOptions): SsrfGuard;
