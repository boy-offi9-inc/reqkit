// Compile-only check: CJS consumers resolve the .d.ts entry.
import reqkit = require("@boy-offi9-inc/reqkit");

export const retry: typeof reqkit.withRetry = reqkit.withRetry;
export const err: reqkit.NormalizedError = reqkit.normalizeError(null);
export const q: string = reqkit.buildQuery({ a: 1 });
export const limiter: reqkit.Limiter = reqkit.createLimiter(2);
export const http: reqkit.ReqkitFetch = reqkit.createFetch({ baseUrl: "https://x.test" });
export const stop: reqkit.StopRetry = new reqkit.StopRetry("x");
