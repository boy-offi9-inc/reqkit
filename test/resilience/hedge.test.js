const test = require("node:test");
const assert = require("node:assert/strict");
const { withHedge } = require("../../src");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// resolves after `ms`, or rejects with the signal's reason if aborted first
const after = (ms, value, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

test("a fast primary never launches a backup", async () => {
  const calls = [];
  const out = await withHedge(async (signal, i) => (calls.push(i), "primary"), { delayMs: 50 });
  assert.equal(out, "primary");
  await sleep(80);
  assert.deepEqual(calls, [0], "the backup timer was cleared");
});

test("a slow primary gets a backup after delayMs; the backup wins and the primary is aborted", async () => {
  let primarySignal;
  const hedges = [];
  let winner;
  const started = Date.now();
  const out = await withHedge(
    (signal, i) => {
      if (i === 0) {
        primarySignal = signal;
        return after(400, "slow", signal);
      }
      return after(10, "fast", signal);
    },
    { delayMs: 40, onHedge: (h) => hedges.push(h.index), onWinner: (i) => (winner = i) }
  );
  assert.equal(out, "fast");
  assert.ok(Date.now() - started < 250, `took ${Date.now() - started}ms instead of 400`);
  assert.deepEqual(hedges, [1]);
  assert.equal(winner, 1);
  assert.equal(primarySignal.aborted, true, "the slow one was cancelled");
  assert.equal(primarySignal.reason.name, "AbortError");
});

test("the primary can still win after a backup was launched (and the backup is cancelled)", async () => {
  let backupSignal;
  const out = await withHedge(
    (signal, i) => (i === 0 ? after(70, "primary", signal) : ((backupSignal = signal), after(500, "backup", signal))),
    { delayMs: 30 }
  );
  assert.equal(out, "primary");
  assert.equal(backupSignal.aborted, true);
});

test("maxHedges: 2 launches a second backup after another delay", async () => {
  const launched = [];
  const stamps = [];
  const t0 = Date.now();
  await withHedge(
    (signal, i) => {
      launched.push(i);
      stamps.push(Date.now() - t0);
      return i < 2 ? after(1000, "no", signal) : after(5, "third", signal);
    },
    { delayMs: 40, maxHedges: 2 }
  );
  assert.deepEqual(launched, [0, 1, 2]);
  assert.ok(stamps[1] >= 35 && stamps[2] >= 75, `launch times ${stamps.join(", ")}`);
});

test("maxHedges: 0 behaves like a plain call", async () => {
  const calls = [];
  const out = await withHedge((signal, i) => (calls.push(i), after(60, "only", signal)), { delayMs: 10, maxHedges: 0 });
  assert.equal(out, "only");
  assert.deepEqual(calls, [0]);
});

test("delayMs can be a function of the backup number", async () => {
  const stamps = [];
  const t0 = Date.now();
  await withHedge(
    (signal, i) => {
      stamps.push(Date.now() - t0);
      return i < 2 ? after(1000, "no", signal) : "ok";
    },
    { delayMs: (n) => n * 30, maxHedges: 2 }
  );
  assert.ok(stamps[1] >= 25 && stamps[1] < 55, `backup 1 at ${stamps[1]}ms`);
  assert.ok(stamps[2] >= 80, `backup 2 at ${stamps[2]}ms (30 + 60)`);
});

test("an attempt that throws launches the next backup immediately", async () => {
  const stamps = [];
  const t0 = Date.now();
  const out = await withHedge(
    async (signal, i) => {
      stamps.push(Date.now() - t0);
      if (i === 0) throw new Error("connection reset");
      return "recovered";
    },
    { delayMs: 500 }
  );
  assert.equal(out, "recovered");
  assert.ok(stamps[1] < 100, `backup started at ${stamps[1]}ms, not after the 500ms delay`);
});

test("hedgeOnError:false waits for the timer even when the primary fails", async () => {
  const stamps = [];
  const t0 = Date.now();
  await withHedge(
    async (signal, i) => {
      stamps.push(Date.now() - t0);
      if (i === 0) throw new Error("boom");
      return "ok";
    },
    { delayMs: 60, hedgeOnError: false }
  );
  assert.ok(stamps[1] >= 55, `backup at ${stamps[1]}ms`);
});

test("when every attempt throws, the last error is rejected", async () => {
  await assert.rejects(
    withHedge(async (signal, i) => {
      throw new Error(`fail ${i}`);
    }, { delayMs: 10, maxHedges: 2 }),
    /fail 2/
  );
});

test("a failed result (status >= 500) triggers the backup immediately; a good backup wins", async () => {
  const stamps = [];
  const t0 = Date.now();
  const out = await withHedge(
    async (signal, i) => {
      stamps.push(Date.now() - t0);
      return i === 0 ? { status: 503 } : { status: 200 };
    },
    { delayMs: 500 }
  );
  assert.equal(out.status, 200);
  assert.ok(stamps[1] < 100);
});

test("if every attempt returns a failed result, the last one is resolved (not thrown) and earlier bodies are discarded", async () => {
  let cancelled = 0;
  const make = (status) => ({ status, bodyUsed: false, body: { cancel: async () => void cancelled++ } });
  const out = await withHedge(async (signal, i) => make(500 + i), { delayMs: 5, maxHedges: 2 });
  assert.equal(out.status, 502, "the last failure is returned");
  assert.equal(cancelled, 2, "the two earlier failed responses were cancelled");
});

test("a loser that resolves after the winner has its body cancelled", async () => {
  let cancelled = 0;
  const loser = { status: 200, bodyUsed: false, body: { cancel: async () => void cancelled++ } };
  const out = await withHedge(
    (signal, i) => (i === 0 ? sleep(60).then(() => loser) : { status: 200, winner: true }),
    { delayMs: 10 }
  );
  assert.equal(out.winner, true);
  await sleep(100);
  assert.equal(cancelled, 1);
});

test("custom isFailure", async () => {
  const out = await withHedge(async (signal, i) => ({ ok: i === 1 }), { delayMs: 500, isFailure: (r) => !r.ok });
  assert.equal(out.ok, true);
});

test("an external signal cancels every attempt and rejects with its reason", async () => {
  const c = new AbortController();
  const signals = [];
  const p = withHedge((signal, i) => (signals.push(signal), after(1000, "x", signal)), { delayMs: 20, signal: c.signal });
  setTimeout(() => c.abort(new Error("user navigated away")), 60);
  await assert.rejects(p, /user navigated away/);
  assert.ok(signals.length >= 2 && signals.every((s) => s.aborted));
});

test("an already-aborted signal rejects without calling fn", async () => {
  const c = new AbortController();
  c.abort();
  let called = false;
  await assert.rejects(withHedge(() => ((called = true), "x"), { delayMs: 10, signal: c.signal }), (e) => e.name === "AbortError");
  assert.equal(called, false);
});

test("losers never leak unhandled rejections", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await withHedge((signal, i) => (i === 0 ? after(200, "slow", signal) : after(5, "fast", signal)), { delayMs: 20 });
    await sleep(50);
  } finally {
    process.off("unhandledRejection", listener);
  }
  assert.deepEqual(unhandled, []);
});

test("a throwing onHedge / onWinner callback is ignored", async () => {
  const out = await withHedge((signal, i) => (i === 0 ? after(100, "slow", signal) : "fast"), {
    delayMs: 10,
    onHedge: () => {
      throw new Error("logger crashed");
    },
    onWinner: () => {
      throw new Error("logger crashed");
    },
  });
  assert.equal(out, "fast");
});

test("a synchronous throw inside fn counts as a failed attempt", async () => {
  const out = await withHedge((signal, i) => {
    if (i === 0) throw new Error("sync boom");
    return "ok";
  }, { delayMs: 500 });
  assert.equal(out, "ok");
});

test("validates its options", async () => {
  await assert.rejects(withHedge(async () => 1, {}), TypeError);
  await assert.rejects(withHedge(async () => 1, { delayMs: -1 }), TypeError);
  await assert.rejects(withHedge(async () => 1, { delayMs: 10, maxHedges: 1.5 }), TypeError);
  await assert.rejects(withHedge(async () => 1, { delayMs: 10, maxHedges: -1 }), TypeError);
});
