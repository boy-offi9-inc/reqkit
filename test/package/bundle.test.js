const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..", "..");
const bundlePath = path.join(root, "playground", "reqkit.mjs");

test("the committed playground/reqkit.mjs bundle is up to date (run `npm run build` if this fails)", () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reqkit-bundle-")), "reqkit.mjs");
  execFileSync(process.execPath, [path.join(root, "scripts", "build-esm.js"), tmp], { stdio: "ignore" });
  assert.equal(fs.readFileSync(bundlePath, "utf8"), fs.readFileSync(tmp, "utf8"));
});

test("the ESM bundle exposes exactly the same exports as the CommonJS entry", async () => {
  const bundle = await import(pathToFileURL(bundlePath).href);
  const cjs = require("../../src");
  assert.deepEqual(Object.keys(bundle).filter((k) => k !== "default").sort(), Object.keys(cjs).sort());
  for (const key of Object.keys(cjs)) assert.equal(typeof bundle[key], typeof cjs[key], key);
});

test("the bundle is self-contained (no imports or requires of anything else)", () => {
  const text = fs.readFileSync(bundlePath, "utf8");
  assert.equal(/^import\s/m.test(text), false, "no static imports");
  assert.equal(/require\(\s*["'][^./]/.test(text), false, "no bare requires");
});

