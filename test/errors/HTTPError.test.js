const test = require("node:test");
const assert = require("node:assert/strict");
const { HTTPError } = require("../../src/errors/HTTPError");
const { normalizeError } = require("../../src/errors/normalizeError");

test("HTTPError carries status, statusText, method and url", () => {
  const response = new Response(null, { status: 404, statusText: "Not Found" });
  const err = new HTTPError(response, { method: "GET", url: "https://api.example.com/users/7" });

  assert.equal(err.name, "HTTPError");
  assert.equal(err.status, 404);
  assert.equal(err.statusText, "Not Found");
  assert.equal(err.method, "GET");
  assert.equal(err.url, "https://api.example.com/users/7");
  assert.equal(err.response, response);
  assert.equal(
    err.message,
    "Request failed with status 404 Not Found: GET https://api.example.com/users/7",
  );
  assert.ok(err instanceof Error);
});

test("HTTPError omits statusText from the message when the response has none", () => {
  const err = new HTTPError(new Response(null, { status: 500 }), {
    method: "POST",
    url: "https://api.example.com/things",
  });

  assert.equal(err.statusText, "");
  assert.equal(err.message, "Request failed with status 500: POST https://api.example.com/things");
});

test("HTTPError is safe to construct in environments without a real Response", () => {
  const err = new HTTPError(
    { status: 429, statusText: "Too Many Requests" },
    { method: "GET", url: "https://api.example.com/quota" },
  );

  assert.equal(err.status, 429);
  assert.equal(err.statusText, "Too Many Requests");
  assert.equal(err.message, "Request failed with status 429 Too Many Requests: GET https://api.example.com/quota");
});

test("normalizeError recognizes an HTTPError's status", () => {
  const err = new HTTPError(new Response(null, { status: 403, statusText: "Forbidden" }), {
    method: "GET",
    url: "https://api.example.com/admin",
  });

  const result = normalizeError(err);
  assert.equal(result.status, 403);
  assert.equal(result.message, err.message);
  assert.equal(result.isNetworkError, false);
  assert.equal(result.isTimeout, false);
  assert.equal(result.isAborted, false);
});
