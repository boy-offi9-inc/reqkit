const test = require("node:test");
const assert = require("node:assert/strict");
const { withProgress } = require("../src/withProgress");

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
