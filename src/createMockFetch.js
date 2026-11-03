const { abortableSleep } = require("./_sleep");

const BODYLESS = new Set([101, 204, 205, 304]);

function toBody(body, headers) {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) ||
    body instanceof URLSearchParams
  ) {
    return body;
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return JSON.stringify(body);
}

function buildResponse(status, body, extraHeaders) {
  const headers = new Headers(extraHeaders || undefined);
  const payload = BODYLESS.has(status) ? null : toBody(body, headers);
  return new Response(payload, { status, headers });
}

function matchesUrl(matcher, url) {
  if (typeof matcher === "function") return Boolean(matcher(url));
  if (matcher instanceof RegExp) return matcher.test(url);
  if (matcher === "*" || matcher === undefined) return true;
  if (url === matcher) return true;
  try {
    const u = new URL(url);
    if (matcher === u.pathname + u.search) return true;
    if (!String(matcher).includes("?") && matcher === u.pathname) return true;
  } catch {
    // relative/odd URL — exact match only
  }
  return false;
}

/**
 * A scriptable, fetch-compatible test double — for testing code that uses
 * retries, timeouts, rate limits and so on without a network.
 *
 * ```js
 * const mock = createMockFetch();
 * mock.on("GET", "/users/1")
 *   .replyOnce(503, "busy", { headers: { "retry-after": "0" } })
 *   .reply(200, { id: 1 });
 * mock.on("POST", /\/orders/).fail(mock.networkError());
 *
 * const api = createFetch({ fetch: mock.fetch, baseUrl: "https://api.test" });
 * await api.json("/users/1");          // → { id: 1 } after one retry
 * mock.calls.length;                   // 2
 * ```
 *
 * String matchers match the full URL, `pathname + search`, or the bare
 * `pathname`; you can also pass a RegExp or a `(url) => boolean`. `"*"` as the
 * method matches any method. Unmatched requests reject with a clear error.
 */
function createMockFetch() {
  let routes = [];
  const calls = [];

  function on(method, matcher) {
    const route = { method: String(method).toUpperCase(), matcher, once: [], fallback: null };
    routes.push(route);

    const chain = {
      /** Always answer like this (once any `…Once` replies are used up). */
      reply(status = 200, body, opts) {
        route.fallback = replyHandler(status, body, opts);
        return chain;
      },
      replyOnce(status = 200, body, opts) {
        route.once.push(replyHandler(status, body, opts));
        return chain;
      },
      /** `fn(call)` returns a Response, `{ status, body, headers }`, or throws/rejects. */
      replyWith(fn) {
        route.fallback = customHandler(fn);
        return chain;
      },
      replyWithOnce(fn) {
        route.once.push(customHandler(fn));
        return chain;
      },
      /** Reject like fetch does on a network failure. */
      fail(err = networkError()) {
        route.fallback = async () => {
          throw err;
        };
        return chain;
      },
      failOnce(err = networkError()) {
        route.once.push(async () => {
          throw err;
        });
        return chain;
      },
    };
    return chain;
  }

  function replyHandler(status, body, opts = {}) {
    return async (call) => {
      if (opts.delayMs) await abortableSleep(opts.delayMs, call.signal);
      return buildResponse(status, body, opts.headers);
    };
  }

  function customHandler(fn) {
    return async (call) => {
      const out = await fn(call);
      if (out instanceof Response) return out;
      return buildResponse(out.status ?? 200, out.body, out.headers);
    };
  }

  function networkError(code = "ECONNREFUSED") {
    const err = new TypeError("fetch failed");
    err.cause = Object.assign(new Error(`connect ${code}`), { code });
    return err;
  }

  async function mockFetch(input, init = {}) {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const method = String(init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    const signal = init.signal || (typeof input === "object" ? input.signal : undefined);
    signal?.throwIfAborted?.();

    const headers = {};
    new Headers(init.headers || (typeof input === "object" ? input.headers : undefined)).forEach((v, k) => {
      headers[k] = v;
    });

    const call = {
      url,
      method,
      headers,
      body: init.body,
      signal,
      get json() {
        try {
          return typeof this.body === "string" ? JSON.parse(this.body) : undefined;
        } catch {
          return undefined;
        }
      },
    };
    calls.push(call);

    const route = routes.find(
      (r) => (r.method === "*" || r.method === method) && matchesUrl(r.matcher, url) && (r.once.length > 0 || r.fallback)
    );
    if (!route) {
      throw new Error(`createMockFetch: no mock registered for ${method} ${url}`);
    }
    const handler = route.once.length > 0 ? route.once.shift() : route.fallback;
    return handler(call);
  }

  return {
    fetch: mockFetch,
    on,
    get: (m) => on("GET", m),
    post: (m) => on("POST", m),
    put: (m) => on("PUT", m),
    patch: (m) => on("PATCH", m),
    delete: (m) => on("DELETE", m),
    /** A TypeError("fetch failed") with `cause.code`, like Node's fetch throws. */
    networkError,
    /** Every request made so far, in order. */
    calls,
    /** Remove all routes and forget recorded calls. */
    reset() {
      routes = [];
      calls.length = 0;
    },
  };
}

module.exports = { createMockFetch };
