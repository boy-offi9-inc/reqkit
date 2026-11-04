const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");

test("the committed docs/reqkit.mjs bundle is up to date (run `npm run build` if this fails)", () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reqkit-bundle-")), "reqkit.mjs");
  execFileSync(process.execPath, [path.join(root, "scripts", "build-esm.js"), tmp], { stdio: "ignore" });
  assert.equal(fs.readFileSync(path.join(root, "docs", "reqkit.mjs"), "utf8"), fs.readFileSync(tmp, "utf8"));
});

test("the ESM bundle exposes exactly the same exports as the CommonJS entry", async () => {
  const bundle = await import(pathToFileURL(path.join(root, "docs", "reqkit.mjs")).href);
  const cjs = require("../src");
  assert.deepEqual(Object.keys(bundle).filter((k) => k !== "default").sort(), Object.keys(cjs).sort());
  for (const key of Object.keys(cjs)) assert.equal(typeof bundle[key], typeof cjs[key], key);
});

test("the bundle is self-contained (no imports or requires of anything else)", () => {
  const text = fs.readFileSync(path.join(root, "docs", "reqkit.mjs"), "utf8");
  assert.equal(/^import\s/m.test(text), false, "no static imports");
  assert.equal(/require\(\s*["'][^./]/.test(text), false, "no bare requires");
});

async function loadDemos() {
  return (await import(pathToFileURL(path.join(root, "docs", "demo.mjs")).href)).demos;
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
