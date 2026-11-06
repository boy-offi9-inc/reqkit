const test = require("node:test");
const assert = require("node:assert/strict");
const { buildQuery } = require("../../src/http/buildQuery");

test("buildQuery builds a simple query string", () => {
  assert.equal(buildQuery({ a: 1, b: "two" }), "a=1&b=two");
});

test("buildQuery skips null and undefined values", () => {
  assert.equal(buildQuery({ a: 1, b: null, c: undefined, d: 2 }), "a=1&d=2");
});

test("buildQuery repeats the key for arrays", () => {
  assert.equal(buildQuery({ tag: ["a", "b", "c"] }), "tag=a&tag=b&tag=c");
});

test("buildQuery encodes special characters", () => {
  assert.equal(buildQuery({ q: "hello world & stuff" }), "q=hello%20world%20%26%20stuff");
});

test("buildQuery handles empty/null input", () => {
  assert.equal(buildQuery(null), "");
  assert.equal(buildQuery(undefined), "");
  assert.equal(buildQuery({}), "");
});

test("buildQuery serializes Dates as ISO 8601", () => {
  assert.equal(buildQuery({ since: new Date(0) }), "since=1970-01-01T00%3A00%3A00.000Z");
});

test("buildQuery serializes arrays of Dates", () => {
  assert.equal(
    buildQuery({ d: [new Date(0), new Date(1000)] }),
    "d=1970-01-01T00%3A00%3A00.000Z&d=1970-01-01T00%3A00%3A01.000Z"
  );
});

test("buildQuery throws on nested objects instead of emitting [object Object]", () => {
  assert.throws(() => buildQuery({ filter: { a: 1 } }), /filter/);
  assert.throws(() => buildQuery({ list: [{ a: 1 }] }), /list/);
});

test("buildQuery throws on invalid Dates", () => {
  assert.throws(() => buildQuery({ d: new Date("nope") }), /invalid Date/);
});

test("buildQuery still handles booleans, numbers and bigint", () => {
  assert.equal(buildQuery({ a: true, b: 0, c: 10n }), "a=true&b=0&c=10");
});
