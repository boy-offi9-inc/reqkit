// Compile-only check: ESM consumers (node16/nodenext) resolve the .d.mts entry.
import reqkit, {
  withRetry,
  withTimeout,
  normalizeError,
  retryAfterAware,
  withProgress,
  withDedupe,
  BodyTooLargeError,
  RetryAbortedError,
  type NormalizedError,
} from "@boy-offi9-inc/reqkit";

const n: NormalizedError = normalizeError(new Error("x"));
const aborted: boolean = n.isAborted;

export async function check(res: Response, signal: AbortSignal) {
  await withRetry(async (attempt) => attempt, { retries: 1, signal });
  await withTimeout((s) => fetch("https://example.com", { signal: s }), 1000);
  await retryAfterAware(() => fetch("https://example.com"), {
    signal,
    shouldRetryError: (err) => Boolean(err),
    onRetryError: (_err, waitMs) => void waitMs,
  });
  const bytes: Uint8Array = await withProgress(res, ({ percent }) => void percent, { maxBytes: 10, signal });
  const getUser = withDedupe(async (id: number) => id);
  const id: number = await getUser(1);
  const e = new BodyTooLargeError(1);
  const code: "EBODYTOOLARGE" = e.code;
  const cause: unknown = new RetryAbortedError().cause;
  return [aborted, bytes, id, code, cause, reqkit.withRetry];
}
