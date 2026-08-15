const test = require("node:test");
const assert = require("node:assert/strict");
const { buildQuery } = require("../src/buildQuery");

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
