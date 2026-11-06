const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..", "..");

// A tiny DOM stub — just enough surface for playground/index.html's inline script.
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this.attrs = {};
    this.className = "";
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._text = "";
  }
  set textContent(v) {
    this._text = v;
    if (v === "") this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  append(...cs) {
    cs.forEach((c) => this.children.push(c));
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(type, fn) {
    this.handlers[type] = fn;
  }
}

test("playground/index.html's inline script renders every demo and the Run buttons work", async () => {
  const html = fs.readFileSync(path.join(root, "playground", "index.html"), "utf8");
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];

  // run it as a real module, with the demo import pointed at the file on disk
  const demoUrl = pathToFileURL(path.join(root, "playground", "demo.mjs")).href;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reqkit-dom-"));
  const file = path.join(tmpDir, "glue.mjs");
  fs.writeFileSync(file, script.replace('"./demo.mjs"', JSON.stringify(demoUrl)));

  const container = new El("div");
  globalThis.document = {
    getElementById: (id) => (id === "demos" ? container : null),
    createElement: (tag) => new El(tag),
  };
  try {
    await import(pathToFileURL(file).href);
  } finally {
    // keep `document` until the click below has run
  }

  assert.equal(container.children.length, 9, "one card per demo");
  const titles = container.children.map((card) => card.children[0].textContent);
  assert.ok(titles.includes("Retry that obeys Retry-After"));

  // Click Run on the SSE demo (index 4) and wait for it to finish.
  const card = container.children[4];
  const [, , , button, log] = card.children;
  assert.equal(button.textContent, "▶ Run");
  await button.handlers.click();
  assert.equal(button.disabled, false, "button re-enabled afterwards");
  assert.ok(log.children.length >= 3, "log lines were appended");
  assert.ok(log.children.at(-1).textContent.includes("✓"));
  assert.equal(log.children.at(-1).className, "ok-line");
  delete globalThis.document;
});

test("a failing demo shows an error line instead of breaking the page", async () => {
  const html = fs.readFileSync(path.join(root, "playground", "index.html"), "utf8");
  assert.ok(html.includes("write(`✗ ${err && err.name}: ${err && err.message}`)"), "error branch present in the page script");
});
