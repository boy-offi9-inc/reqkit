const test = require("node:test");
const assert = require("node:assert/strict");
const { parseJsonSafe } = require("../src/parseJsonSafe");

test("parseJsonSafe parses valid JSON string", async () => {
  const result = await parseJsonSafe('{"ok": true}');
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.error, null);
});

test("parseJsonSafe returns error (not throw) on malformed JSON", async () => {
  const result = await parseJsonSafe("{not valid json");
  assert.equal(result.data, null);
  assert.ok(result.error instanceof Error);
});

test("parseJsonSafe handles empty string as null data, no error", async () => {
  const result = await parseJsonSafe("");
  assert.equal(result.data, null);
  assert.equal(result.error, null);
});

test("parseJsonSafe accepts a Response-like object with .text()", async () => {
  const fakeResponse = { text: async () => '{"fromResponse": 1}' };
  const result = await parseJsonSafe(fakeResponse);
  assert.deepEqual(result.data, { fromResponse: 1 });
});
