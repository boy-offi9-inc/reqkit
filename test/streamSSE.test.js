const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./_server");
const { streamSSE, createFetch, createMockFetch, HTTPError } = require("../src");

const FAST = { reconnectDelayMs: 5, maxDelayMs: 20 };
const collect = async (it, max = 100) => {
  const out = [];
  for await (const ev of it) {
    out.push(ev);
    if (out.length >= max) break;
  }
  return out;
};

function sse(res, body, { status = 200, end = true } = {}) {
  res.statusCode = status;
  res.setHeader("content-type", "text/event-stream");
  res.write(body);
  if (end) res.end();
}

test("streamSSE yields events and sends the SSE request headers", async () => {
  let seen;
  const srv = await startServer((req, res) => {
    seen = req.headers;
    sse(res, "id: 1\ndata: a\n\ndata: [DONE]\n\n");
  });
  try {
    const events = await collect(streamSSE(`${srv.url}/e`, { stopWhen: (e) => e.data === "[DONE]" }));
    assert.deepEqual(events.map((e) => e.data), ["a", "[DONE]"]);
    assert.equal(seen.accept, "text/event-stream");
    assert.equal(seen["cache-control"], "no-cache");
    assert.equal(seen["last-event-id"], undefined, "no Last-Event-ID on the first connect");
    assert.equal(srv.hits(), 1, "stopWhen ends the stream without reconnecting");
  } finally {
    await srv.close();
  }
});

test("streamSSE reconnects after a clean end and resumes with Last-Event-ID", async () => {
  const lastIds = [];
  const srv = await startServer((req, res, hit) => {
    lastIds.push(req.headers["last-event-id"]);
    if (hit === 1) return sse(res, "id: 1\ndata: one\n\nid: 2\ndata: two\n\n");
    if (hit === 2) return sse(res, "id: 3\ndata: three\n\n");
    res.statusCode = 204; // "stop reconnecting"
    res.end();
  });
  try {
    const reconnects = [];
    const events = await collect(streamSSE(`${srv.url}/e`, { ...FAST, onReconnect: (i) => reconnects.push([i.reason, i.lastEventId]) }));
    assert.deepEqual(events.map((e) => e.data), ["one", "two", "three"]);
    assert.deepEqual(lastIds, [undefined, "2", "3"]);
    assert.deepEqual(reconnects, [["end", "2"], ["end", "3"]]);
  } finally {
    await srv.close();
  }
});

test("streamSSE reconnects after the connection is dropped mid-stream", async () => {
  const lastIds = [];
  const srv = await startServer((req, res, hit) => {
    lastIds.push(req.headers["last-event-id"]);
    if (hit === 1) {
      sse(res, "id: 10\ndata: before-drop\n\n", { end: false });
      setTimeout(() => res.socket.destroy(), 10);
      return;
    }
    if (hit === 2) return sse(res, "id: 11\ndata: after-drop\n\n");
    res.statusCode = 204;
    res.end();
  });
  try {
    const reasons = [];
    const events = await collect(streamSSE(`${srv.url}/e`, { ...FAST, onReconnect: (i) => reasons.push(i.reason) }));
    assert.deepEqual(events.map((e) => e.data), ["before-drop", "after-drop"]);
    assert.equal(lastIds[1], "10");
    assert.equal(reasons[0], "error");
  } finally {
    await srv.close();
  }
});

test("streamSSE uses the server's `retry:` field as the reconnect delay", async () => {
  const stamps = [];
  const srv = await startServer((req, res, hit) => {
    stamps.push(Date.now());
    if (hit === 1) return sse(res, "retry: 60\nid: 1\ndata: x\n\n");
    res.statusCode = 204;
    res.end();
  });
  try {
    await collect(streamSSE(`${srv.url}/e`, { reconnectDelayMs: 2000, maxDelayMs: 5000 }));
    const gap = stamps[1] - stamps[0];
    assert.ok(gap >= 55 && gap < 500, `reconnected after ${gap}ms (server said 60, our default was 2000)`);
  } finally {
    await srv.close();
  }
});

test("streamSSE honors Retry-After on a 503 and then connects", async () => {
  const stamps = [];
  const srv = await startServer((req, res, hit) => {
    stamps.push(Date.now());
    if (hit === 1) {
      res.statusCode = 503;
      res.setHeader("retry-after", "0.1");
      return res.end("busy");
    }
    sse(res, "data: hello\n\n");
  });
  try {
    const events = await collect(streamSSE(`${srv.url}/e`, { ...FAST, reconnect: true, stopWhen: () => true }));
    assert.equal(events[0].data, "hello");
    assert.ok(stamps[1] - stamps[0] >= 90, `waited ${stamps[1] - stamps[0]}ms`);
  } finally {
    await srv.close();
  }
});

test("streamSSE throws HTTPError immediately for non-retryable statuses", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 401;
    res.end("no");
  });
  try {
    await assert.rejects(collect(streamSSE(`${srv.url}/e`, FAST)), (e) => e instanceof HTTPError && e.status === 401);
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("streamSSE rejects a response that isn't an event stream", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  try {
    await assert.rejects(collect(streamSSE(`${srv.url}/e`, FAST)), (e) => e.code === "SSE_BAD_CONTENT_TYPE");
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("streamSSE gives up after `retries` consecutive failures (HTTP 500)", async () => {
  const srv = await startServer((req, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  try {
    await assert.rejects(collect(streamSSE(`${srv.url}/e`, { ...FAST, retries: 2 })), (e) => e instanceof HTTPError && e.status === 500);
    assert.equal(srv.hits(), 3, "first try + 2 retries");
  } finally {
    await srv.close();
  }
});

test("streamSSE gives up when the server keeps closing without sending events", async () => {
  const srv = await startServer((req, res) => sse(res, ": just a comment\n\n"));
  try {
    await assert.rejects(collect(streamSSE(`${srv.url}/e`, { ...FAST, retries: 2 })), (e) => e.code === "SSE_GAVE_UP");
    assert.equal(srv.hits(), 3);
  } finally {
    await srv.close();
  }
});

test("a connection that delivered events resets the failure counter", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit % 2 === 1) return sse(res, `id: ${hit}\ndata: ok${hit}\n\n`); // good connection
    res.statusCode = 500; // then a failure — never two failures in a row
    res.end("x");
  });
  try {
    const events = await collect(streamSSE(`${srv.url}/e`, { ...FAST, retries: 1 }), 5);
    assert.equal(events.length, 5, "kept going well past retries:1 total failures");
  } finally {
    await srv.close();
  }
});

test("streamSSE retries a refused connection, then throws the network error", async () => {
  const net = require("node:net");
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  const attempts = [];
  await assert.rejects(
    collect(streamSSE(`http://127.0.0.1:${port}/e`, { ...FAST, retries: 2, onReconnect: (i) => attempts.push(i.attempt) })),
    (e) => e.name === "TypeError"
  );
  assert.deepEqual(attempts, [1, 2]);
});

test("streamSSE stops when the signal aborts (mid-stream and mid-backoff)", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: first\n\n"); // then hang
  });
  try {
    const c = new AbortController();
    const seen = [];
    await assert.rejects(async () => {
      for await (const ev of streamSSE(`${srv.url}/e`, { signal: c.signal })) {
        seen.push(ev.data);
        setTimeout(() => c.abort(), 10);
      }
    }, (e) => e.name === "AbortError");
    assert.deepEqual(seen, ["first"]);
  } finally {
    await srv.close();
  }

  const down = await startServer((req, res) => ((res.statusCode = 503), res.setHeader("retry-after", "30"), res.end()));
  try {
    const c = new AbortController();
    const p = collect(streamSSE(`${down.url}/e`, { signal: c.signal }));
    setTimeout(() => c.abort(), 30);
    await assert.rejects(p, (e) => e.name === "AbortError");
  } finally {
    await down.close();
  }
});

test("breaking out of the loop closes the connection (no reconnect)", async () => {
  let closed = false;
  const srv = await startServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.on("close", () => (closed = true));
    res.write("data: 1\n\ndata: 2\n\ndata: 3\n\n");
  });
  try {
    for await (const ev of streamSSE(`${srv.url}/e`)) {
      if (ev.data === "1") break;
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, true);
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("POST streams don't reconnect by default; reconnect:true opts in", async () => {
  const bodies = [];
  const srv = await startServer((req, res, hit) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(raw);
      if (hit === 1) return sse(res, "id: 1\ndata: a\n\n");
      res.statusCode = 204;
      res.end();
    });
  });
  try {
    const first = await collect(streamSSE(`${srv.url}/e`, { method: "POST", body: '{"q":1}', ...FAST }));
    assert.equal(first.length, 1);
    assert.equal(srv.hits(), 1, "clean end of a POST stream is the end");

    const second = await collect(streamSSE(`${srv.url}/e`, { method: "POST", body: '{"q":2}', reconnect: true, ...FAST }));
    assert.equal(second.length, 0); // hit 2 is a 204 → ends
    assert.deepEqual(bodies, ['{"q":1}', '{"q":2}']);
  } finally {
    await srv.close();
  }
});

test("a dropped POST stream throws instead of silently re-sending the request", async () => {
  const srv = await startServer((req, res) => {
    req.resume();
    req.on("end", () => {
      sse(res, "id: 1\ndata: partial\n\n", { end: false });
      setTimeout(() => res.socket.destroy(), 10);
    });
  });
  try {
    const seen = [];
    await assert.rejects(async () => {
      for await (const ev of streamSSE(`${srv.url}/e`, { method: "POST", body: "{}" })) seen.push(ev.data);
    }, (e) => e.name === "TypeError");
    assert.deepEqual(seen, ["partial"]);
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("headers can be a function, re-evaluated on every (re)connect", async () => {
  const tokens = [];
  const srv = await startServer((req, res, hit) => {
    tokens.push(req.headers.authorization);
    if (hit === 1) return sse(res, "id: 1\ndata: a\n\n");
    res.statusCode = 204;
    res.end();
  });
  try {
    let n = 0;
    await collect(streamSSE(`${srv.url}/e`, { ...FAST, headers: () => ({ authorization: `Bearer t${++n}` }) }));
    assert.deepEqual(tokens, ["Bearer t1", "Bearer t2"]);
  } finally {
    await srv.close();
  }
});

test("lastEventId option resumes on the very first connect; onOpen fires per connection", async () => {
  let firstHeader;
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) firstHeader = req.headers["last-event-id"];
    if (hit === 1) return sse(res, "id: 8\ndata: x\n\n");
    res.statusCode = 204;
    res.end();
  });
  try {
    const opens = [];
    await collect(streamSSE(`${srv.url}/e`, { ...FAST, lastEventId: "7", onOpen: (i) => opens.push([i.connections, i.lastEventId]) }));
    assert.equal(firstHeader, "7");
    assert.deepEqual(opens, [[1, "7"]]);
  } finally {
    await srv.close();
  }
});

test("works with a createFetch instance as the fetch (HTTPError path)", async () => {
  const srv = await startServer((req, res, hit) => {
    if (hit === 1) {
      res.statusCode = 404;
      return res.end("nope");
    }
    sse(res, "data: x\n\n");
  });
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false });
    await assert.rejects(collect(streamSSE("/e", { fetch: api })), (e) => e instanceof HTTPError && e.status === 404);
  } finally {
    await srv.close();
  }
});

test("works with createMockFetch: Last-Event-ID shows up in recorded calls", async () => {
  const mock = createMockFetch();
  const stream = (text) =>
    new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) }), {
      headers: { "content-type": "text/event-stream" },
    });
  mock
    .get("/events")
    .replyWithOnce(() => stream("id: a1\ndata: one\n\n"))
    .replyWithOnce(() => stream("id: a2\ndata: two\n\n"))
    .reply(204);
  const events = await collect(streamSSE("https://t.test/events", { fetch: mock.fetch, ...FAST }));
  assert.deepEqual(events.map((e) => e.data), ["one", "two"]);
  assert.deepEqual(mock.calls.map((c) => c.headers["last-event-id"]), [undefined, "a1", "a2"]);
});

test("normalizeError treats undici's bare `terminated` and Chromium's `network error` as network errors", () => {
  const { normalizeError } = require("../src/normalizeError");
  assert.equal(normalizeError(new TypeError("terminated")).isNetworkError, true);
  assert.equal(normalizeError(new TypeError("network error")).isNetworkError, true);
  assert.equal(normalizeError(new TypeError("x is not a function")).isNetworkError, false);
});
