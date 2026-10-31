const test = require("node:test");
const assert = require("node:assert/strict");

test("CJS and ESM entry points expose exactly the same named exports", async () => {
  const cjs = require("../src/index.js");
  const esm = await import("../src/index.mjs");

  const cjsKeys = Object.keys(cjs).sort();
  const esmKeys = Object.keys(esm).filter((k) => k !== "default").sort();

  assert.deepEqual(esmKeys, cjsKeys);
  for (const key of cjsKeys) assert.equal(esm[key], cjs[key], `${key} differs between CJS and ESM`);
  assert.equal(esm.default, cjs);
});
