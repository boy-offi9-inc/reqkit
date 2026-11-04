// Compile-only check: CJS consumers resolve the .d.ts entry.
import reqkit = require("@boy-offi9-inc/reqkit");

export const retry: typeof reqkit.withRetry = reqkit.withRetry;
export const err: reqkit.NormalizedError = reqkit.normalizeError(null);
export const q: string = reqkit.buildQuery({ a: 1 });
export const limiter: reqkit.Limiter = reqkit.createLimiter(2);
export const http: reqkit.ReqkitFetch = reqkit.createFetch({ baseUrl: "https://x.test" });
export const stop: reqkit.StopRetry = new reqkit.StopRetry("x");
export const rl: reqkit.RateLimiter = reqkit.createRateLimiter({ requests: 1 });
export const breaker: reqkit.CircuitBreaker = reqkit.createCircuitBreaker();
export const mock: reqkit.MockFetch = reqkit.createMockFetch();
export const lines: AsyncGenerator<string, void, undefined> = reqkit.readLines(new Response("x"));
export const sse: AsyncGenerator<reqkit.SSEEvent, void, undefined> = reqkit.streamSSE("https://x.test/e");
