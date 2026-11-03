const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockFetch } = require("../src/createMockFetch");
const { createFetch } = require("../src/createFetch");
const { withRetry } = require("../src/withRetry");
const { withTimeout } = require("../src/withTimeout");

test("mock replies with JSON bodies and records calls", async () => {
  const mock = createMockFetch();
  mock.get("/users/1").reply(200, { id: 1 });
  const res = await mock.fetch("https://api.test/users/1?x=1", { headers: { Authorization: "t" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { id: 1 });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].headers.authorization, "t");
});

test("mock matchers: full URL, path+search, bare path, RegExp, function, wildcard method", async () => {
  const mock = createMockFetch();
  mock.on("*", "https://a.test/full").reply(200, "full");
  mock.get("/p?q=1").reply(200, "pathsearch");
  mock.get("/bare").reply(200, "bare");
  mock.get(/regex/).reply(200, "regex");
  mock.get((u) => u.endsWith("/fn")).reply(200, "fn");
  const text = async (u, init) => (await mock.fetch(u, init)).text();
  assert.equal(await text("https://a.test/full", { method: "DELETE" }), "full");
  assert.equal(await text("https://a.test/p?q=1"), "pathsearch");
  assert.equal(await text("https://a.test/bare?whatever=1"), "bare");
  assert.equal(await text("https://a.test/xregexx"), "regex");
  assert.equal(await text("https://a.test/fn"), "fn");
});

test("replyOnce is consumed in order, then the persistent reply takes over", async () => {
  const mock = createMockFetch();
  mock.get("/x").replyOnce(503).replyOnce(502).reply(200, "ok");
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await mock.fetch("https://t.test/x")).status);
  assert.deepEqual(statuses, [503, 502, 200, 200]);
});

test("unmatched requests reject with a clear message (and are still recorded)", async () => {
  const mock = createMockFetch();
  await assert.rejects(mock.fetch("https://t.test/nope", { method: "POST" }), /no mock registered for POST https:\/\/t\.test\/nope/);
  assert.equal(mock.calls.length, 1);
});

test("fail / failOnce / networkError behave like fetch network failures", async () => {
  const mock = createMockFetch();
  mock.get("/x").failOnce(mock.networkError("ECONNRESET")).reply(200, "up");
  await assert.rejects(mock.fetch("https://t.test/x"), (e) => e instanceof TypeError && e.cause.code === "ECONNRESET");
  assert.equal((await mock.fetch("https://t.test/x")).status, 200);
});

test("replyWith can inspect the call and return a Response or a plain object", async () => {
  const mock = createMockFetch();
  mock.post("/echo").replyWith((call) => ({ status: 201, body: { got: call.json } }));
  mock.get("/raw").replyWith(() => new Response("raw!", { status: 202 }));
  const res = await mock.fetch("https://t.test/echo", { method: "POST", body: JSON.stringify({ a: 1 }) });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { got: { a: 1 } });
  assert.equal((await mock.fetch("https://t.test/raw")).status, 202);
});

test("bodyless statuses and extra headers are handled", async () => {
  const mock = createMockFetch();
  mock.get("/empty").reply(204);
  mock.get("/h").reply(200, "x", { headers: { "x-a": "1" } });
  assert.equal((await mock.fetch("https://t.test/empty")).status, 204);
  assert.equal((await mock.fetch("https://t.test/h")).headers.get("x-a"), "1");
});

test("delayMs respects the abort signal, so timeouts can be tested", async () => {
  const mock = createMockFetch();
  mock.get("/slow").reply(200, "late", { delayMs: 500 });
  await assert.rejects(withTimeout((signal) => mock.fetch("https://t.test/slow", { signal }), 20), (e) => e.name === "TimeoutError");
});

test("a pre-aborted signal rejects before the request is recorded", async () => {
  const mock = createMockFetch();
  mock.get("/x").reply(200);
  const c = new AbortController();
  c.abort();
  await assert.rejects(mock.fetch("https://t.test/x", { signal: c.signal }), (e) => e.name === "AbortError");
  assert.equal(mock.calls.length, 0);
});

test("reset clears routes and calls", async () => {
  const mock = createMockFetch();
  mock.get("/x").reply(200);
  await mock.fetch("https://t.test/x");
  mock.reset();
  assert.equal(mock.calls.length, 0);
  await assert.rejects(mock.fetch("https://t.test/x"), /no mock/);
});

test("works end to end with withRetry and createFetch", async () => {
  const mock = createMockFetch();
  mock.get("/a").replyOnce(503, "busy", { headers: { "retry-after": "0" } }).reply(200, "ok");
  const res = await withRetry(() => mock.fetch("https://t.test/a"), { retryStatusCodes: [503], baseDelayMs: 1 });
  assert.equal(await res.text(), "ok");

  mock.reset();
  mock.get("/u").failOnce(mock.networkError()).replyOnce(500, "x").reply(200, { id: 9 });
  const api = createFetch({ fetch: mock.fetch, baseUrl: "https://api.test", retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  assert.deepEqual(await api.json("/u"), { id: 9 });
  assert.equal(mock.calls.length, 3);
});
