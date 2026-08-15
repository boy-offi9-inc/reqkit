const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeError } = require("../src/normalizeError");

test("normalizeError handles null/undefined", () => {
  const result = normalizeError(null);
  assert.equal(result.message, "Unknown error");
  assert.equal(result.status, null);
});

test("normalizeError handles a plain Error", () => {
  const result = normalizeError(new Error("plain failure"));
  assert.equal(result.message, "plain failure");
  assert.equal(result.status, null);
  assert.equal(result.isNetworkError, false);
});

test("normalizeError handles an axios-style error", () => {
  const axiosErr = {
    isAxiosError: true,
    message: "Request failed with status code 404",
    config: {},
    response: { status: 404, data: { message: "Not found" } },
  };
  const result = normalizeError(axiosErr);
  assert.equal(result.status, 404);
  assert.equal(result.message, "Not found");
});

test("normalizeError handles an axios network error (no response)", () => {
  const axiosErr = {
    isAxiosError: true,
    message: "Network Error",
    config: {},
    request: {},
  };
  const result = normalizeError(axiosErr);
  assert.equal(result.isNetworkError, true);
  assert.equal(result.status, null);
});

test("normalizeError handles a fetch Response passed directly", () => {
  const fakeResponse = { status: 500, ok: false, statusText: "Internal Server Error" };
  const result = normalizeError(fakeResponse);
  assert.equal(result.status, 500);
  assert.equal(result.message, "Internal Server Error");
});

test("normalizeError handles AbortError", () => {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  const result = normalizeError(err);
  assert.equal(result.isTimeout, true);
  assert.equal(result.code, "ETIMEDOUT");
});

test("normalizeError handles node-style network error codes", () => {
  const err = new Error("connect ECONNREFUSED 127.0.0.1:3000");
  err.code = "ECONNREFUSED";
  const result = normalizeError(err);
  assert.equal(result.isNetworkError, true);
  assert.equal(result.code, "ECONNREFUSED");
});
