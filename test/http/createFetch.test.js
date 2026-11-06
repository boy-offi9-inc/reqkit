const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../helpers/server");
const { createFetch, HTTPError, TimeoutError } = require("../../src");

const FAST = { baseDelayMs: 1, maxDelayMs: 5 };

test("createFetch joins baseUrl, query and sends json bodies", async () => {
  const seen = {};
  const srv = await startServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      Object.assign(seen, { url: req.url, method: req.method, ct: req.headers["content-type"], auth: req.headers.authorization, raw });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const api = createFetch({ baseUrl: `${srv.url}/v1/`, headers: { authorization: "Bearer t" } });
    const data = await api.json("/users", { method: "POST", query: { page: 2, tag: ["a", "b"] }, json: { name: "x" } });
    assert.deepEqual(data, { ok: true });
    assert.equal(seen.url, "/v1/users?page=2&tag=a&tag=b");
    assert.equal(seen.method, "POST");
    assert.equal(seen.ct, "application/json");
    assert.equal(seen.auth, "Bearer t");
    assert.equal(seen.raw, '{"name":"x"}');
  } finally {
    await srv.close();
  }
});

test("createFetch accepts absolute URLs and dynamic header functions", async () => {
  let token = 0;
  const seen = [];
  const srv = await startServer((req, res) => {
    seen.push(req.headers["x-token"]);
    res.end("ok");
  });
  try {
    const api = createFetch({ baseUrl: "http://ignored.invalid", headers: () => ({ "x-token": String(++token) }) });
    await api(`${srv.url}/a`);
    await api(`${srv.url}/b`);
    assert.deepEqual(seen, ["1", "2"]);
  } finally {
    await srv.close();
  }
});

test("createFetch throws HTTPError with a readable response on non-2xx", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 404;
    res.end('{"error":"nope"}');
  });
  try {
    const api = createFetch({ baseUrl: srv.url });
    let err;
    try {
      await api("/missing");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof HTTPError);
    assert.equal(err.status, 404);
    assert.equal(err.method, "GET");
    assert.match(err.message, /404/);
    assert.deepEqual(await err.response.json(), { error: "nope" });
    assert.equal(srv.hits(), 1, "404 is not retried");
  } finally {
    await srv.close();
  }
});

test("createFetch returns the response when throwHttpErrors is false", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 418;
    res.end("teapot");
  });
  try {
    const res = await createFetch({ baseUrl: srv.url, throwHttpErrors: false })("/");
    assert.equal(res.status, 418);
  } finally {
    await srv.close();
  }
});

test("createFetch retries retryable statuses on GET and honors Retry-After", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit < 3) {
      res.statusCode = 503;
      res.setHeader("retry-after", "0");
      res.end("busy");
    } else {
      res.end("done");
    }
  });
  try {
    const retries = [];
    const api = createFetch({ baseUrl: srv.url, retry: { retries: 3, ...FAST, onRetry: (e, a, ms, ctx) => retries.push(ctx.status) } });
    const res = await api("/");
    assert.equal(await res.text(), "done");
    assert.equal(srv.hits(), 3);
    assert.deepEqual(retries, [503, 503]);
  } finally {
    await srv.close();
  }
});

test("createFetch does not retry POST by default, even on 503", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 503;
    res.end("busy");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, retry: FAST });
    await assert.rejects(api("/", { method: "POST", json: {} }), HTTPError);
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("createFetch retries POST when an Idempotency-Key header is set", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) {
      res.statusCode = 503;
      res.setHeader("retry-after", "0");
      res.end("busy");
    } else res.end("ok");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, retry: FAST });
    const res = await api("/", { method: "POST", json: { a: 1 }, headers: { "Idempotency-Key": "k1" } });
    assert.equal(res.status, 200);
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("createFetch retries POST when the method is explicitly allowed", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) {
      res.statusCode = 502;
      res.end("bad gateway");
    } else res.end("ok");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, retry: { ...FAST, methods: ["GET", "POST"] } });
    const res = await api("/", { method: "POST", json: {} });
    assert.equal(res.status, 200);
  } finally {
    await srv.close();
  }
});

test("createFetch gives up after the retry budget and throws HTTPError for the last status", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, retry: { retries: 2, ...FAST } });
    await assert.rejects(api("/"), (err) => err instanceof HTTPError && err.status === 500);
    assert.equal(srv.hits(), 3);
  } finally {
    await srv.close();
  }
});

test("createFetch retry:false disables retrying", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 503;
    res.end("busy");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false });
    await assert.rejects(api("/"), HTTPError);
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("createFetch applies a per-attempt timeout and retries it", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) return; // hang the first attempt
    res.end("fast");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, timeout: 50, retry: { retries: 1, ...FAST } });
    const res = await api("/");
    assert.equal(await res.text(), "fast");
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("createFetch surfaces TimeoutError when every attempt times out", async () => {
  const srv = await startServer(() => {});
  try {
    const api = createFetch({ baseUrl: srv.url, timeout: 30, retry: { retries: 1, ...FAST } });
    await assert.rejects(api("/"), TimeoutError);
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("createFetch retries real network failures (connection refused)", async () => {
  const net = require("node:net");
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));

  let retried = 0;
  const api = createFetch({ baseUrl: `http://127.0.0.1:${port}`, retry: { retries: 2, ...FAST, onRetry: () => retried++ } });
  await assert.rejects(api("/"), (err) => err.name === "TypeError");
  assert.equal(retried, 2);
});

test("createFetch rethrows a plain AbortError when the caller aborts", async () => {
  const srv = await startServer(() => {});
  try {
    const controller = new AbortController();
    const api = createFetch({ baseUrl: srv.url, timeout: false });
    const promise = api("/", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(promise, (err) => err.name === "AbortError");
    assert.equal(srv.hits(), 1, "an abort is never retried");
  } finally {
    await srv.close();
  }
});

test("createFetch rethrows AbortError (not RetryAbortedError) when aborted during backoff", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 503;
    res.setHeader("retry-after", "30");
    res.end("busy");
  });
  try {
    const controller = new AbortController();
    const api = createFetch({ baseUrl: srv.url });
    const promise = api("/", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(promise, (err) => err.name === "AbortError");
  } finally {
    await srv.close();
  }
});

test("createFetch dedupes concurrent GETs and hands each caller a readable response", async () => {
  const srv = await startServer((req, res) => {
    setTimeout(() => res.end("shared"), 30);
  });
  try {
    const api = createFetch({ baseUrl: srv.url, dedupe: true });
    const [a, b, c] = await Promise.all([api("/x"), api("/x"), api("/x")]);
    assert.equal(srv.hits(), 1);
    assert.deepEqual(await Promise.all([a.text(), b.text(), c.text()]), ["shared", "shared", "shared"]);

    await api("/x"); // not a cache: the next call goes out again
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("createFetch does not dedupe requests that carry their own signal", async () => {
  const srv = await startServer((req, res) => setTimeout(() => res.end("x"), 20));
  try {
    const api = createFetch({ baseUrl: srv.url, dedupe: true });
    const a = new AbortController();
    const b = new AbortController();
    await Promise.all([api("/x", { signal: a.signal }), api("/x", { signal: b.signal })]);
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("createFetch.json returns null for an empty body and throws on invalid JSON", async () => {
  const srv = await startServer((req, res) => {
    if (req.url === "/empty") {
      res.statusCode = 204;
      res.end();
    } else res.end("{not json");
  });
  try {
    const api = createFetch({ baseUrl: srv.url });
    assert.equal(await api.json("/empty"), null);
    await assert.rejects(api.json("/bad"), SyntaxError);
  } finally {
    await srv.close();
  }
});

test("createFetch.extend merges headers and retry options over the parent", async () => {
  const seen = {};
  const srv = await startServer((req, res) => {
    Object.assign(seen, { a: req.headers["x-a"], b: req.headers["x-b"] });
    res.end("ok");
  });
  try {
    const base = createFetch({ baseUrl: srv.url, headers: { "x-a": "1" }, retry: { retries: 5 } });
    const child = base.extend({ headers: { "x-b": "2" }, retry: { baseDelayMs: 1 } });
    await child("/");
    assert.deepEqual(seen, { a: "1", b: "2" });
  } finally {
    await srv.close();
  }
});

test("createFetch runs onRequest / onResponse hooks and accepts a custom fetch", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.get("authorization") });
    return new Response("hello", { status: 200 });
  };
  const events = [];
  const api = createFetch({
    baseUrl: "https://api.test",
    fetch: fakeFetch,
    onRequest: (ctx) => {
      ctx.init.headers.set("authorization", "Bearer hook");
      events.push("req");
    },
    onResponse: ({ response }) => {
      events.push(`res:${response.status}`);
    },
  });
  const res = await api("/ping");
  assert.equal(await res.text(), "hello");
  assert.deepEqual(calls, [{ url: "https://api.test/ping", auth: "Bearer hook" }]);
  assert.deepEqual(events, ["req", "res:200"]);
});

test("createFetch does not retry a stream body", async () => {
  let attempts = 0;
  const fakeFetch = async () => {
    attempts++;
    return new Response("busy", { status: 503 });
  };
  const api = createFetch({ fetch: fakeFetch, retry: { ...FAST, methods: ["POST"] } });
  const body = new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array([1])), c.close()) });
  await assert.rejects(api("https://x.test/", { method: "POST", body, duplex: "half" }), HTTPError);
  assert.equal(attempts, 1);
});
