const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./_server");
const { downloadResumable } = require("../src/downloadResumable");
const { BodyTooLargeError } = require("../src/withProgress");
const { HTTPError } = require("../src/HTTPError");

const FILE = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const FAST = { baseDelayMs: 1, maxDelayMs: 2 };

// Range-capable server. `plan(hit)` can ask to cut the connection after N bytes.
function fileServer({ etag = '"v1"', plan = () => ({}), supportRange = true, onRequest } = {}) {
  return startServer((req, res, hit) => {
    onRequest?.(req, hit);
    const p = plan(hit);
    if (p.status) {
      res.statusCode = p.status;
      if (p.retryAfter) res.setHeader("retry-after", p.retryAfter);
      return res.end("err");
    }
    let start = 0;
    let status = 200;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || "");
    const ifRange = req.headers["if-range"];
    if (supportRange && range && (!ifRange || ifRange === etag)) {
      start = Number(range[1]);
      status = 206;
    }
    if (start >= FILE.length) {
      res.statusCode = 416;
      return res.end();
    }
    const body = FILE.subarray(start);
    res.statusCode = status;
    res.setHeader("etag", etag);
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-length", body.length);
    if (status === 206) res.setHeader("content-range", `bytes ${start}-${FILE.length - 1}/${FILE.length}`);
    if (p.cutAfter !== undefined) {
      res.write(body.subarray(0, p.cutAfter));
      setTimeout(() => res.socket.destroy(), 5);
      return;
    }
    res.end(body);
  });
}

test("downloadResumable downloads a whole file and reports progress", async () => {
  const srv = await fileServer();
  try {
    const events = [];
    const out = await downloadResumable(`${srv.url}/f`, { onProgress: (p) => events.push(p) });
    assert.deepEqual(Buffer.from(out), FILE);
    assert.equal(events.at(-1).percent, 100);
    assert.equal(events.at(-1).total, FILE.length);
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("downloadResumable resumes with a Range request after the connection drops", async () => {
  const ranges = [];
  const srv = await fileServer({
    plan: (hit) => (hit === 1 ? { cutAfter: 1200 } : {}),
    onRequest: (req) => ranges.push([req.headers.range, req.headers["if-range"]]),
  });
  try {
    const retries = [];
    const out = await downloadResumable(`${srv.url}/f`, { ...FAST, onRetry: (e, a, d, info) => retries.push(info.resumeFrom) });
    assert.deepEqual(Buffer.from(out), FILE);
    assert.equal(srv.hits(), 2);
    assert.equal(ranges[0][0], undefined);
    assert.match(ranges[1][0], /^bytes=\d+-$/);
    assert.equal(ranges[1][1], '"v1"', "If-Range carries the ETag");
    assert.ok(retries[0] > 0 && retries[0] < FILE.length, `resumed from ${retries[0]}`);
  } finally {
    await srv.close();
  }
});

test("downloadResumable survives several drops as long as it keeps making progress", async () => {
  const srv = await fileServer({ plan: (hit) => (hit <= 4 ? { cutAfter: 700 } : {}) });
  try {
    const out = await downloadResumable(`${srv.url}/f`, { ...FAST, retries: 1 });
    assert.deepEqual(Buffer.from(out), FILE);
    assert.ok(srv.hits() >= 5);
  } finally {
    await srv.close();
  }
});

test("downloadResumable restarts from zero when the server ignores Range", async () => {
  const srv = await fileServer({ supportRange: false, plan: (hit) => (hit === 1 ? { cutAfter: 900 } : {}) });
  try {
    const out = await downloadResumable(`${srv.url}/f`, FAST);
    assert.equal(out.byteLength, FILE.length);
    assert.deepEqual(Buffer.from(out), FILE);
  } finally {
    await srv.close();
  }
});

test("downloadResumable restarts (does not stitch) when the file changed on the server", async () => {
  let version = '"v1"';
  const srv = await startServer((req, res, hit) => {
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || "");
    const ifRange = req.headers["if-range"];
    const matches = !ifRange || ifRange === version;
    const start = range && matches ? Number(range[1]) : 0;
    const content = Buffer.from(version === '"v1"' ? "A".repeat(3000) : "B".repeat(3000));
    const body = content.subarray(start);
    res.statusCode = start > 0 ? 206 : 200;
    res.setHeader("etag", version);
    res.setHeader("content-length", body.length);
    if (start > 0) res.setHeader("content-range", `bytes ${start}-2999/3000`);
    if (hit === 1) {
      res.write(body.subarray(0, 1000));
      version = '"v2"'; // file changes while we're mid-download
      setTimeout(() => res.socket.destroy(), 5);
      return;
    }
    res.end(body);
  });
  try {
    const out = Buffer.from(await downloadResumable(`${srv.url}/f`, FAST)).toString();
    assert.equal(out, "B".repeat(3000), "result is entirely the new version");
  } finally {
    await srv.close();
  }
});

test("downloadResumable gives up after `retries` attempts without progress", async () => {
  const srv = await fileServer({ plan: () => ({ cutAfter: 0 }) });
  try {
    await assert.rejects(downloadResumable(`${srv.url}/f`, { ...FAST, retries: 2 }));
    assert.equal(srv.hits(), 3);
  } finally {
    await srv.close();
  }
});

test("downloadResumable retries 503 honoring Retry-After, but not 404", async () => {
  const srv = await fileServer({ plan: (hit) => (hit === 1 ? { status: 503, retryAfter: "0" } : {}) });
  try {
    const out = await downloadResumable(`${srv.url}/f`, FAST);
    assert.equal(out.byteLength, FILE.length);
  } finally {
    await srv.close();
  }
  const nf = await fileServer({ plan: () => ({ status: 404 }) });
  try {
    await assert.rejects(downloadResumable(`${nf.url}/f`, FAST), (e) => e instanceof HTTPError && e.status === 404);
    assert.equal(nf.hits(), 1);
  } finally {
    await nf.close();
  }
});

test("downloadResumable enforces maxBytes (declared and streamed)", async () => {
  const srv = await fileServer();
  try {
    await assert.rejects(downloadResumable(`${srv.url}/f`, { maxBytes: 100 }), BodyTooLargeError);
    assert.equal(srv.hits(), 1, "not retried");
  } finally {
    await srv.close();
  }
});

test("downloadResumable aborts with the signal's reason", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("content-length", 100);
    res.write("x"); // never finishes
  });
  try {
    const controller = new AbortController();
    const p = downloadResumable(`${srv.url}/f`, { signal: controller.signal, ...FAST });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(p, (e) => e.name === "AbortError");
  } finally {
    await srv.close();
  }
});

test("downloadResumable restarts on 416 without counting a retry", async () => {
  let n = 0;
  const fakeFetch = async (url, init) => {
    n++;
    if (n === 1) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "10", etag: '"x"' } });
    }
    if (n === 2) return new Response(null, { status: 416 });
    return new Response(new Uint8Array(10).fill(7), { status: 200, headers: { "content-length": "10" } });
  };
  const out = await downloadResumable("https://x.test/f", { fetch: fakeFetch, ...FAST, retries: 1 });
  assert.deepEqual(Array.from(out), new Array(10).fill(7));
});
