// Guards the layering described in docs/architecture.md. If one of these fails,
// either the new dependency is a mistake, or the architecture doc (and ALLOWED
// below) should change on purpose.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const srcDir = path.join(root, "src");

// layer → the layers it may require (besides itself). Lower layers know nothing about higher ones.
const ALLOWED = {
  internal: [],
  errors: ["internal"],
  resilience: ["internal", "errors"],
  http: ["internal", "errors", "resilience"],
  streams: ["internal", "errors"],
  pagination: ["internal", "errors"],
  testing: ["internal"],
};
const LAYERS = Object.keys(ALLOWED);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const files = walk(srcDir).filter((f) => f.endsWith(".js"));
const rel = (f) => path.relative(srcDir, f).split(path.sep).join("/");
const layerOf = (f) => rel(f).split("/")[0];

function resolveRequire(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${rel(from)}: cannot resolve require("${spec}")`);
}

const graph = new Map(); // file → files it requires
for (const file of files) {
  const specs = [...fs.readFileSync(file, "utf8").matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  graph.set(file, specs.map((spec) => ({ spec, target: spec.startsWith(".") ? resolveRequire(file, spec) : null })));
}

test("src/ contains only index.js/index.mjs and the known layers", () => {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) assert.ok(LAYERS.includes(e.name), `unknown layer directory src/${e.name} — add it to docs/architecture.md and ALLOWED`);
    else assert.ok(["index.js", "index.mjs"].includes(e.name), `src/${e.name}: only the entry points live at the top level`);
  }
  for (const layer of LAYERS) assert.ok(fs.existsSync(path.join(srcDir, layer)), `layer ${layer} has no directory`);
});

test("src/ has no runtime dependencies: every require is relative", () => {
  for (const [file, deps] of graph) {
    for (const { spec } of deps) assert.ok(spec.startsWith("."), `${rel(file)} requires "${spec}" — reqkit is dependency-free (and bundled without a bundler)`);
  }
});

test("layers only depend downward (see docs/architecture.md)", () => {
  for (const [file, deps] of graph) {
    if (path.basename(file) === "index.js" && path.dirname(file) === srcDir) continue; // the entry point may import anything
    const from = layerOf(file);
    for (const { target } of deps) {
      const to = layerOf(target);
      if (to === from) continue;
      assert.ok(ALLOWED[from].includes(to), `${rel(file)} (layer "${from}") must not depend on ${rel(target)} (layer "${to}"). "${from}" may use: ${ALLOWED[from].join(", ") || "nothing"}`);
    }
  }
});

test("there are no circular requires", () => {
  const state = new Map(); // 1 = in progress, 2 = done
  const stack = [];
  function visit(file) {
    if (state.get(file) === 2) return;
    if (state.get(file) === 1) throw new Error(`circular require: ${[...stack.slice(stack.indexOf(file)), file].map(rel).join(" → ")}`);
    state.set(file, 1);
    stack.push(file);
    for (const { target } of graph.get(file) || []) visit(target);
    stack.pop();
    state.set(file, 2);
  }
  for (const file of files) visit(file);
});

test("every module is reachable from src/index.js (no dead code)", () => {
  const reached = new Set();
  (function visit(file) {
    if (reached.has(file)) return;
    reached.add(file);
    for (const { target } of graph.get(file) || []) visit(target);
  })(path.join(srcDir, "index.js"));
  const dead = files.filter((f) => !reached.has(f)).map(rel);
  assert.deepEqual(dead, [], `unreachable from the entry point: ${dead.join(", ")}`);
});

test("types/ mirrors the layers: one declaration file per layer, re-exported by index.d.ts", () => {
  const typesDir = path.join(root, "types");
  const declared = fs.readdirSync(typesDir).filter((f) => f.endsWith(".d.ts") && f !== "index.d.ts").map((f) => f.replace(/\.d\.ts$/, "")).sort();
  assert.deepEqual(declared, LAYERS.filter((l) => l !== "internal").sort());
  const index = fs.readFileSync(path.join(typesDir, "index.d.ts"), "utf8");
  for (const name of declared) assert.ok(index.includes(`export * from "./${name}";`), `types/index.d.ts doesn't re-export ./${name}`);
});

test("tests mirror the layers: every public layer has a test directory", () => {
  for (const layer of LAYERS.filter((l) => l !== "internal")) {
    const dir = path.join(root, "test", layer);
    assert.ok(fs.existsSync(dir) && walk(dir).some((f) => f.endsWith(".test.js")), `test/${layer}/ has no tests`);
  }
});
