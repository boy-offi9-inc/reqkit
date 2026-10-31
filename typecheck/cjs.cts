// Compile-only check: CJS consumers resolve the .d.ts entry.
import reqkit = require("@boy-offi9-inc/reqkit");

export const retry: typeof reqkit.withRetry = reqkit.withRetry;
export const err: reqkit.NormalizedError = reqkit.normalizeError(null);
export const q: string = reqkit.buildQuery({ a: 1 });
