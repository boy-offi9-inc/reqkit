// Compile-only check: ESM consumers (node16/nodenext) resolve the .d.mts entry.
import reqkit, {
  withRetry,
  withTimeout,
  normalizeError,
  retryAfterAware,
  withProgress,
  withDedupe,
  createLimiter,
  createFetch,
  HTTPError,
  StopRetry,
  BodyTooLargeError,
  RetryAbortedError,
  type NormalizedError,
} from "@boy-offi9-inc/reqkit";

const n: NormalizedError = normalizeError(new Error("x"));
const aborted: boolean = n.isAborted;

export async function check(res: Response, signal: AbortSignal) {
  await withRetry(async (attempt) => attempt, {
    retries: Infinity,
    jitter: "full",
    maxRetryTime: 5000,
    retryStatusCodes: [429],
    calculateDelay: ({ delayMs }) => (delayMs > 100 ? false : delayMs),
    onRetry: (_err, _attempt, _ms, ctx) => void ctx.status,
    signal,
  });
  try {
    await withRetry(async () => {
      throw new StopRetry(new Error("fatal"));
    });
  } catch {}
  await withTimeout((s) => fetch("https://example.com", { signal: s }), 1000, { signal });
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

  const limit = createLimiter(4);
  const doubled: number[] = await limit.map([1, 2, 3], async (x) => x * 2);
  const one: string = await limit((a: string, b: string) => a + b, "x", "y");
  const active: number = limit.activeCount;

  const api = createFetch({
    baseUrl: "https://api.example.com",
    headers: async () => ({ authorization: "Bearer t" }),
    timeout: 5000,
    retry: { retries: 3, statusCodes: [503], methods: ["GET", "POST"], jitter: "full" },
    dedupe: true,
    onRequest: ({ init }) => init.headers.set("x-id", "1"),
  });
  const child = api.extend({ retry: false });
  const user = await child.json<{ id: number }>("/users/1", { query: { a: 1 }, signal });
  const created = await api("/users", { method: "POST", json: { name: "x" }, timeout: false });
  let status = 0;
  try {
    await api("/nope");
  } catch (err) {
    if (err instanceof HTTPError) status = err.status;
  }

  return [aborted, bytes, id, code, cause, doubled, one, active, user.id, created.ok, status, reqkit.withRetry];
}

// ---- 0.4.0 surface ----------------------------------------------------------
import {
  createRateLimiter,
  createCircuitBreaker,
  CircuitOpenError,
  createMemoryCache,
  createMockFetch,
  downloadResumable,
  readLines,
  readNDJSON,
  readSSE,
} from "@boy-offi9-inc/reqkit";

export async function check040(res: Response, signal: AbortSignal) {
  const rl = createRateLimiter({ requests: 5, perMs: 1000 });
  await rl.acquire({ signal });
  rl.update(res);
  const viaRun: Response = await rl.run(() => fetch("https://x.test"));
  const blocked: number = rl.blockedForMs;

  const cb = createCircuitBreaker({ failureThreshold: 3, onStateChange: (s, prev) => void [s, prev] });
  const state: "closed" | "open" | "half-open" = cb.state;
  try {
    await cb.run(async () => 1);
  } catch (e) {
    if (e instanceof CircuitOpenError) void e.retryAfterMs;
  }

  const store = createMemoryCache({ maxEntries: 10 });
  const api = createFetch({
    baseUrl: "https://api.test",
    rateLimit: rl,
    circuitBreaker: (url) => createCircuitBreaker(),
    cache: { ttl: 1000, staleWhileRevalidate: 5000, store, onEvent: (e) => void e.type },
  });
  await api("/x", { cache: "reload" });
  const other = createFetch({ rateLimit: { requests: 2, perMs: 100 }, circuitBreaker: true, cache: true });

  const mock = createMockFetch();
  mock.get("/users").replyOnce(503, "busy", { headers: { "retry-after": "0" }, delayMs: 5 }).reply(200, { ok: true });
  mock.post(/orders/).replyWith((call) => ({ status: 201, body: call.json })).failOnce(mock.networkError("ECONNRESET"));
  const mocked = createFetch({ fetch: mock.fetch });
  const calls: number = mock.calls.length;

  const bytes: Uint8Array = await downloadResumable("https://x.test/f", { retries: 2, maxBytes: 10, signal });
  for await (const line of readLines(res, { signal })) void line.length;
  for await (const row of readNDJSON<{ id: number }>(res)) void row.id;
  for await (const ev of readSSE(res)) void [ev.event, ev.data, ev.id, ev.retry];

  return [viaRun, blocked, state, other, mocked, calls, bytes];
}

// the dependency-free bundle has the same types
import { createFetch as createFetchBrowser, withRetry as withRetryBrowser } from "@boy-offi9-inc/reqkit/browser";
export const viaBundle = [createFetchBrowser({ baseUrl: "https://x.test" }), withRetryBrowser];
