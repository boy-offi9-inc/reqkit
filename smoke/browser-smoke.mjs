// CI helper: serves the repo root, opens smoke/browser.html in headless Chromium
// and fails if any check fails. Run after `npm run build`:
//   npx playwright install --with-deps chromium && node smoke/browser-smoke.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript" };

const server = createServer(async (req, res) => {
  try {
    const file = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
    if (!file.startsWith(root)) throw new Error("outside root");
    res.setHeader("content-type", types[extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(0);
await new Promise((r) => server.once("listening", r));

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/smoke/browser.html`);
  await page.waitForFunction("window.__smoke", null, { timeout: 30000 });
  const result = await page.evaluate(() => window.__smoke);
  for (const r of result.results) console.log(r.ok ? `ok   - ${r.name}` : `FAIL - ${r.name}: ${r.error}`);
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  process.exitCode = result.failed > 0 ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
