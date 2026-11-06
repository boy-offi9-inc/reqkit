const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeError } = require("../../src/errors/normalizeError");

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

test("normalizeError handles node-style network error codes", () => {
  const err = new Error("connect ECONNREFUSED 127.0.0.1:3000");
  err.code = "ECONNREFUSED";
  const result = normalizeError(err);
  assert.equal(result.isNetworkError, true);
  assert.equal(result.code, "ECONNREFUSED");
});

test("normalizeError treats a plain AbortError as aborted, not a timeout", () => {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  const result = normalizeError(err);
  assert.equal(result.isAborted, true);
  assert.equal(result.isTimeout, false);
  assert.equal(result.code, "ABORT_ERR");
});

test("normalizeError flags TimeoutError (reqkit / AbortSignal.timeout) as a timeout", () => {
  const err = new Error("Timed out after 5ms");
  err.name = "TimeoutError";
  const result = normalizeError(err);
  assert.equal(result.isTimeout, true);
  assert.equal(result.isAborted, false);
  assert.equal(result.code, "ETIMEDOUT");
});

test("normalizeError reads the real code from `TypeError: fetch failed` cause", () => {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  const result = normalizeError(err);
  assert.equal(result.isNetworkError, true);
  assert.equal(result.code, "ECONNREFUSED");
  assert.equal(result.message, "fetch failed");
});

test("normalizeError finds codes inside an AggregateError cause", () => {
  const err = new TypeError("fetch failed");
  err.cause = new AggregateError([Object.assign(new Error("x"), { code: "ENOTFOUND" })]);
  const result = normalizeError(err);
  assert.equal(result.isNetworkError, true);
  assert.equal(result.code, "ENOTFOUND");
});

test("normalizeError flags undici timeouts via cause as timeouts", () => {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  const result = normalizeError(err);
  assert.equal(result.isTimeout, true);
  assert.equal(result.isNetworkError, false);
  assert.equal(result.code, "UND_ERR_CONNECT_TIMEOUT");
});

test("normalizeError treats browser 'Failed to fetch' as a network error", () => {
  const result = normalizeError(new TypeError("Failed to fetch"));
  assert.equal(result.isNetworkError, true);
  assert.equal(result.code, null);
});

test("normalizeError does not mistake ERR_* programming errors for network errors", () => {
  const err = Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" });
  const result = normalizeError(err);
  assert.equal(result.isNetworkError, false);
  assert.equal(result.code, "ERR_INVALID_URL");
});

test("normalizeError classifies a real refused fetch() as a network error", async () => {
  const net = require("node:net");
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));

  let caught;
  try {
    await fetch(`http://127.0.0.1:${port}/`);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "fetch should have rejected");
  const result = normalizeError(caught);
  assert.equal(result.isNetworkError, true);
  assert.equal(result.code, "ECONNREFUSED");
});

test("normalizeError flags axios cancellation as aborted", () => {
  const result = normalizeError({ isAxiosError: true, message: "canceled", code: "ERR_CANCELED", config: {} });
  assert.equal(result.isAborted, true);
});

test("normalizeError always includes every field", () => {
  const keys = Object.keys(normalizeError(null)).sort();
  assert.deepEqual(keys, ["cause", "code", "isAborted", "isNetworkError", "isTimeout", "message", "status"]);
});
