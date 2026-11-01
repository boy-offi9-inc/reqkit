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

test("withTimeout links an external signal and rejects with its reason", async () => {
  const controller = new AbortController();
  let inner;
  const promise = withTimeout((signal) => {
    inner = signal;
    return new Promise(() => {}); // never settles, ignores the signal
  }, 5000, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (err) => err.name === "AbortError");
  assert.equal(inner.aborted, true);
});

test("withTimeout rejects immediately if the external signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    withTimeout(() => ((called = true), Promise.resolve(1)), 1000, { signal: controller.signal }),
    (err) => err.name === "AbortError"
  );
  assert.equal(called, false);
});

test("withTimeout with ms:Infinity never times out", async () => {
  const value = await withTimeout(() => new Promise((r) => setTimeout(() => r("ok"), 20)), Infinity);
  assert.equal(value, "ok");
});

test("withTimeout validates ms", async () => {
  await assert.rejects(withTimeout(async () => 1, undefined), TypeError);
  await assert.rejects(withTimeout(async () => 1, -5), TypeError);
  await assert.rejects(withTimeout(async () => 1, NaN), TypeError);
});

test("withTimeout still reports TimeoutError (not the external abort) on timeout", async () => {
  const controller = new AbortController();
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), 10, { signal: controller.signal }),
    (err) => err.name === "TimeoutError"
  );
});
