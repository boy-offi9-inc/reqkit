const test = require("node:test");
const assert = require("node:assert/strict");
const { withProgress, BodyTooLargeError } = require("../../src/streams/progress");

function fakeStreamedResponse(chunks, contentLength) {
  let i = 0;
  return {
    headers: { get: (key) => (key.toLowerCase() === "content-length" ? contentLength : null) },
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) {
              return { done: false, value: chunks[i++] };
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
  };
}

test("withProgress collects all chunks into one buffer", async () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
  const response = fakeStreamedResponse(chunks, null);
  const result = await withProgress(response);
  assert.deepEqual(Array.from(result), [1, 2, 3, 4, 5]);
});

test("withProgress reports percent when content-length is known", async () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const response = fakeStreamedResponse(chunks, "4");
  const events = [];
  await withProgress(response, (p) => events.push(p));
  assert.equal(events.length, 2);
  assert.equal(events[0].loaded, 2);
  assert.equal(events[0].percent, 50);
  assert.equal(events[1].percent, 100);
});

test("withProgress reports null percent when content-length is missing", async () => {
  const chunks = [new Uint8Array([1])];
  const response = fakeStreamedResponse(chunks, null);
  const events = [];
  await withProgress(response, (p) => events.push(p));
  assert.equal(events[0].total, null);
  assert.equal(events[0].percent, null);
});

test("withProgress falls back to arrayBuffer when body isn't streamable", async () => {
  const response = {
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
  };
  const events = [];
  const result = await withProgress(response, (p) => events.push(p));
  assert.deepEqual(Array.from(result), [9, 9, 9]);
  assert.equal(events[0].percent, 100);
});

// A response whose reader can be cancelled, like a real ReadableStream:
// cancel() makes any pending/future read() resolve as done.
function cancellableResponse(chunks, headers = {}, { hang = false } = {}) {
  let i = 0;
  let cancelled = false;
  let wake;
  const state = { cancelled: () => cancelled };
  return Object.assign(state, {
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          read() {
            if (cancelled) return Promise.resolve({ done: true, value: undefined });
            if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
            if (hang) return new Promise((resolve) => (wake = resolve));
            return Promise.resolve({ done: true, value: undefined });
          },
          cancel() {
            cancelled = true;
            if (wake) wake({ done: true, value: undefined });
            return Promise.resolve();
          },
        };
      },
    },
  });
}

test("withProgress reports null total when a content-encoding is applied", async () => {
  // Content-Length is the compressed size; decoded bytes would exceed it.
  const response = cancellableResponse([new Uint8Array(10), new Uint8Array(10)], {
    "content-length": "5",
    "content-encoding": "gzip",
  });
  const events = [];
  await withProgress(response, (p) => events.push(p));
  assert.ok(events.every((e) => e.total === null && e.percent === null));
  assert.equal(events[1].loaded, 20);
});

test("withProgress treats content-encoding: identity as uncompressed", async () => {
  const response = cancellableResponse([new Uint8Array(4)], {
    "content-length": "4",
    "content-encoding": "identity",
  });
  const events = [];
  await withProgress(response, (p) => events.push(p));
  assert.equal(events[0].percent, 100);
});

test("withProgress clamps percent to 100 when Content-Length understates the body", async () => {
  const response = cancellableResponse([new Uint8Array(10)], { "content-length": "5" });
  const events = [];
  await withProgress(response, (p) => events.push(p));
  assert.equal(events[0].percent, 100);
});

test("withProgress ignores a garbage Content-Length", async () => {
  const response = cancellableResponse([new Uint8Array(3)], { "content-length": "abc" });
  const events = [];
  await withProgress(response, (p) => events.push(p));
  assert.equal(events[0].total, null);
  assert.equal(events[0].percent, null);
});

test("withProgress enforces maxBytes while streaming and cancels the reader", async () => {
  const response = cancellableResponse([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]);
  await assert.rejects(
    withProgress(response, undefined, { maxBytes: 6 }),
    (err) => err instanceof BodyTooLargeError && err.code === "EBODYTOOLARGE" && err.maxBytes === 6
  );
  assert.equal(response.cancelled(), true);
});

test("withProgress fails fast when Content-Length already exceeds maxBytes", async () => {
  let reads = 0;
  const response = cancellableResponse([new Uint8Array(100)], { "content-length": "100" });
  const origGetReader = response.body.getReader;
  response.body.getReader = () => {
    const r = origGetReader();
    const read = r.read;
    r.read = () => (reads++, read());
    return r;
  };
  await assert.rejects(withProgress(response, undefined, { maxBytes: 10 }), BodyTooLargeError);
  assert.equal(reads, 0);
  assert.equal(response.cancelled(), true);
});

test("withProgress enforces maxBytes on the non-streaming fallback", async () => {
  const response = {
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new Uint8Array(20).buffer,
  };
  await assert.rejects(withProgress(response, undefined, { maxBytes: 10 }), BodyTooLargeError);
});

test("withProgress rejects and cancels the reader when the signal aborts mid-read", async () => {
  const response = cancellableResponse([new Uint8Array(2)], {}, { hang: true });
  const controller = new AbortController();
  const promise = withProgress(response, undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (err) => err.name === "AbortError");
  assert.equal(response.cancelled(), true);
});

test("withProgress rejects immediately for an already-aborted signal", async () => {
  const response = cancellableResponse([new Uint8Array(2)]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withProgress(response, undefined, { signal: controller.signal }), (err) => err.name === "AbortError");
});
