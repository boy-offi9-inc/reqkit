const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..", "..");

async function loadDemos() {
  return (await import(pathToFileURL(path.join(root, "playground", "demo.mjs")).href)).demos;
}

test("every playground demo runs to completion against the fake server", async () => {
  const demos = await loadDemos();
  assert.deepEqual(demos.map((d) => d.id), ["retry", "ratelimit", "breaker", "cache", "sse", "sse-reconnect", "auth-refresh", "pagination", "resume"]);
  for (const demo of demos) {
    const lines = [];
    await demo.run((l) => lines.push(l), { scale: 0.05 });
    assert.ok(lines.length > 0, `${demo.id} logged something`);
    assert.ok(lines.at(-1).includes("✓"), `${demo.id} ends with a success line, got: ${lines.at(-1)}`);
  }
});

test("demo outcomes are what the blurbs promise", async () => {
  const byId = Object.fromEntries((await loadDemos()).map((d) => [d.id, d]));
  const run = (id) => byId[id].run(() => {}, { scale: 0.05 });

  assert.equal((await run("retry")).requests, 3);
  assert.equal((await run("ratelimit")).requests, 7);
  const breaker = await run("breaker");
  assert.equal(breaker.failFast, 2, "calls 4 and 5 failed fast");
  assert.equal(breaker.requests, 4, "3 failures + 1 probe — nothing sent while open");
  assert.equal((await run("cache")).requests, 2, "miss + revalidation; the middle call was a hit");
  assert.equal((await run("sse")).text, "reqkit streams tokens as they arrive.");
  const reconnect = await run("sse-reconnect");
  assert.deepEqual(reconnect.events, [1, 2, 3, 4, 5, 6]);
  assert.equal(reconnect.connections, 2);
  assert.equal(reconnect.lastEventIdSent, "3");
  const auth = await run("auth-refresh");
  assert.equal(auth.refreshes, 1, "five rejected requests, one refresh");
  assert.equal(auth.requests, 10);
  assert.equal(auth.ok, true);
  const pagination = await run("pagination");
  assert.equal(pagination.items, 25);
  assert.equal(pagination.requests, 3, "pages 4 and 5 never requested");
  const resume = await run("resume");
  assert.equal(resume.intact, true);
  assert.equal(resume.requests, 2);
});
