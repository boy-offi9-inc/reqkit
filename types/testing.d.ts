// Test doubles — src/testing/

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
