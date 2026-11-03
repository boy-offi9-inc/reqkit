const test = require("node:test");
const assert = require("node:assert/strict");
const { createCircuitBreaker, CircuitOpenError } = require("../src/createCircuitBreaker");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = () => Promise.reject(new Error("down"));

test("circuit opens after the failure threshold and then fails fast", async () => {
  const states = [];
  const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, onStateChange: (s) => states.push(s) });
  for (let i = 0; i < 3; i++) await assert.rejects(cb.run(fail), /down/);
  assert.equal(cb.state, "open");

  let called = false;
  await assert.rejects(cb.run(async () => (called = true)), (e) => e instanceof CircuitOpenError && e.retryAfterMs > 0);
  assert.equal(called, false);
  assert.deepEqual(states, ["open"]);
});

test("a success resets the consecutive-failure count", async () => {
  const cb = createCircuitBreaker({ failureThreshold: 3 });
  await assert.rejects(cb.run(fail));
  await assert.rejects(cb.run(fail));
  await cb.run(async () => ({ status: 200 }));
  assert.equal(cb.failures, 0);
  await assert.rejects(cb.run(fail));
  assert.equal(cb.state, "closed");
});

test("5xx results count as failures but are still returned", async () => {
  const cb = createCircuitBreaker({ failureThreshold: 2 });
  const r1 = await cb.run(async () => ({ status: 503 }));
  assert.equal(r1.status, 503);
  await cb.run(async () => ({ status: 500 }));
  assert.equal(cb.state, "open");
});

test("4xx results and AbortErrors do not count as failures", async () => {
  const cb = createCircuitBreaker({ failureThreshold: 1 });
  await cb.run(async () => ({ status: 404 }));
  await assert.rejects(cb.run(() => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }))));
  assert.equal(cb.state, "closed");
});

test("half-open: a successful probe closes the circuit", async () => {
  const states = [];
  const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30, onStateChange: (s) => states.push(s) });
  await assert.rejects(cb.run(fail));
  await sleep(40);
  assert.equal(cb.state, "half-open");
  await cb.run(async () => ({ status: 200 }));
  assert.equal(cb.state, "closed");
  assert.deepEqual(states, ["open", "half-open", "closed"]);
});

test("half-open: a failed probe re-opens it, and only halfOpenMax probes run at once", async () => {
  const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30, halfOpenMax: 1 });
  await assert.rejects(cb.run(fail));
  await sleep(40);

  const probe = cb.run(() => sleep(30).then(fail));
  await assert.rejects(cb.run(async () => 1), CircuitOpenError); // second concurrent probe refused
  await assert.rejects(probe, /down/);
  assert.equal(cb.state, "open");
});

test("an aborted probe frees the half-open slot", async () => {
  const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
  await assert.rejects(cb.run(fail));
  await sleep(30);
  await assert.rejects(cb.run(() => Promise.reject(Object.assign(new Error("a"), { name: "AbortError" }))));
  assert.equal(cb.state, "half-open");
  await cb.run(async () => ({ status: 200 })); // slot was freed
  assert.equal(cb.state, "closed");
});

test("custom isFailure and reset()", async () => {
  const cb = createCircuitBreaker({ failureThreshold: 1, isFailure: (v, isErr) => !isErr && v.status === 418 });
  await cb.run(async () => ({ status: 418 }));
  assert.equal(cb.state, "open");
  cb.reset();
  assert.equal(cb.state, "closed");
});

test("CircuitOpenError is not classified as a network error", () => {
  const { normalizeError } = require("../src/normalizeError");
  const n = normalizeError(new CircuitOpenError(10));
  assert.equal(n.isNetworkError, false);
  assert.equal(n.isTimeout, false);
});
