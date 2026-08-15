const test = require("node:test");
const assert = require("node:assert/strict");
const { withTimeout, TimeoutError } = require("../src/withTimeout");

test("withTimeout resolves normally when fn finishes in time", async () => {
  const result = await withTimeout(async () => "done", 100);
  assert.equal(result, "done");
});

test("withTimeout rejects with TimeoutError when fn is too slow", async () => {
  await assert.rejects(
    () => withTimeout(() => new Promise((resolve) => setTimeout(resolve, 200)), 20),
    TimeoutError
  );
});

test("withTimeout passes an AbortSignal to fn", async () => {
  let receivedSignal;
  await withTimeout(async (signal) => {
    receivedSignal = signal;
    return "ok";
  }, 100);
  assert.ok(receivedSignal instanceof AbortSignal);
});

test("withTimeout's signal aborts when the timeout fires", async () => {
  let wasAborted = false;
  await assert.rejects(
    () =>
      withTimeout((signal) => {
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            wasAborted = true;
            reject(new Error("aborted"));
          });
        });
      }, 20),
    TimeoutError
  );
  assert.equal(wasAborted, true);
});
