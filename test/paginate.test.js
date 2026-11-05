const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./_server");
const { paginate, paginatePages, paginateLinks, parseLinkHeader, createFetch, HTTPError } = require("../src");

const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

// ---- parseLinkHeader ---------------------------------------------------------

test("parseLinkHeader parses GitHub-style headers", () => {
  const h = '<https://api.x/items?page=2>; rel="next", <https://api.x/items?page=9>; rel="last", <https://api.x/items?page=1>; rel="first"';
  assert.deepEqual(parseLinkHeader(h), {
    next: "https://api.x/items?page=2",
    last: "https://api.x/items?page=9",
    first: "https://api.x/items?page=1",
  });
});

test("parseLinkHeader handles commas in URLs, extra params, unquoted rel, multiple rels, case", () => {
  const h = '<https://x/a?ids=1,2,3>; title="a, b"; rel=next, </p/9>; REL="prev last"; type="text/html"';
  const links = parseLinkHeader(h, "https://x/start");
  assert.equal(links.next, "https://x/a?ids=1,2,3");
  assert.equal(links.prev, "https://x/p/9");
  assert.equal(links.last, "https://x/p/9");
});

test("parseLinkHeader resolves relative URLs against a base, and tolerates empty/garbage input", () => {
  assert.equal(parseLinkHeader('<?page=2>; rel="next"', "https://x/items?page=1").next, "https://x/items?page=2");
  assert.deepEqual(parseLinkHeader(""), {});
  assert.deepEqual(parseLinkHeader(null), {});
  assert.deepEqual(parseLinkHeader("nonsense"), {});
  assert.deepEqual(parseLinkHeader("<https://x/no-rel>"), {});
});

test("parseLinkHeader: the first link wins when a rel repeats", () => {
  assert.equal(parseLinkHeader('<a>; rel="next", <b>; rel="next"').next, "a");
});

// ---- paginate / paginatePages -------------------------------------------------

function cursorApi(pages) {
  const calls = [];
  const fetchPage = async (cursor, ctx) => {
    calls.push({ cursor, index: ctx.index });
    const i = cursor === undefined ? 0 : Number(cursor);
    return { items: pages[i], next: i + 1 < pages.length ? String(i + 1) : undefined };
  };
  return { fetchPage, calls };
}

test("paginate yields every item across pages and passes cursor + index", async () => {
  const { fetchPage, calls } = cursorApi([[1, 2], [3, 4], [5]]);
  assert.deepEqual(await collect(paginate(fetchPage)), [1, 2, 3, 4, 5]);
  assert.deepEqual(calls, [
    { cursor: undefined, index: 0 },
    { cursor: "1", index: 1 },
    { cursor: "2", index: 2 },
  ]);
});

test("paginatePages yields page objects", async () => {
  const { fetchPage } = cursorApi([["a"], ["b", "c"]]);
  assert.deepEqual(await collect(paginatePages(fetchPage)), [
    { items: ["a"], index: 0, cursor: undefined },
    { items: ["b", "c"], index: 1, cursor: "1" },
  ]);
});

test("paginate is lazy: breaking out never fetches the next page", async () => {
  const { fetchPage, calls } = cursorApi([[1, 2, 3], [4, 5, 6], [7]]);
  for await (const item of paginate(fetchPage)) {
    if (item === 2) break;
  }
  assert.equal(calls.length, 1);
});

test("paginate maxItems stops mid-page without fetching further", async () => {
  const { fetchPage, calls } = cursorApi([[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(await collect(paginate(fetchPage, { maxItems: 2 })), [1, 2]);
  assert.equal(calls.length, 1);
  assert.deepEqual(await collect(paginate(fetchPage, { maxItems: 0 })), []);
  assert.deepEqual(await collect(paginate(fetchPage, { maxItems: 4 })), [1, 2, 3, 4]);
});

test("paginate maxPages and start options", async () => {
  const { fetchPage, calls } = cursorApi([[1], [2], [3], [4]]);
  assert.deepEqual(await collect(paginate(fetchPage, { maxPages: 2 })), [1, 2]);
  calls.length = 0;
  assert.deepEqual(await collect(paginate(fetchPage, { start: "2" })), [3, 4]);
  assert.equal(calls[0].cursor, "2");
});

test("paginate supports offset-style pagination with numeric cursors", async () => {
  const data = Array.from({ length: 7 }, (_, i) => i);
  const LIMIT = 3;
  const items = await collect(
    paginate(async (offset = 0) => {
      const slice = data.slice(offset, offset + LIMIT);
      return { items: slice, next: slice.length === LIMIT ? offset + LIMIT : undefined };
    })
  );
  assert.deepEqual(items, data);
});

test("paginate stops when `next` is null, and handles an empty first page", async () => {
  assert.deepEqual(await collect(paginate(async () => ({ items: [], next: null }))), []);
});

test("paginate refuses to loop when the cursor doesn't advance", async () => {
  await assert.rejects(
    collect(paginate(async () => ({ items: [1], next: "same" }), { start: "same" })),
    (e) => e.code === "PAGINATE_STUCK"
  );
});

test("paginate validates what fetchPage returns", async () => {
  await assert.rejects(collect(paginate(async () => ({ items: "nope" }))), TypeError);
  await assert.rejects(collect(paginate(async () => undefined)), TypeError);
});

test("paginate propagates fetchPage errors and honors the abort signal", async () => {
  await assert.rejects(collect(paginate(async () => { throw new Error("boom"); })), /boom/);

  const c = new AbortController();
  const seen = [];
  await assert.rejects(async () => {
    for await (const x of paginate(async (cursor, { signal }) => ({ items: [1], next: String((Number(cursor) || 0) + 1) }), { signal: c.signal })) {
      seen.push(x);
      if (seen.length === 2) c.abort();
    }
  }, (e) => e.name === "AbortError");
  assert.equal(seen.length, 2);
});

// ---- paginateLinks ---------------------------------------------------------------

function linkServer(totalPages, { shape = "array" } = {}) {
  return startServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const page = Number(u.searchParams.get("page") || 1);
    if (page > totalPages) {
      res.statusCode = 404;
      return res.end("no such page");
    }
    const items = [page * 10 + 1, page * 10 + 2];
    if (page < totalPages) res.setHeader("link", `<${u.pathname}?page=${page + 1}>; rel="next", <${u.pathname}?page=${totalPages}>; rel="last"`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(shape === "array" ? items : { items, total: 99 }));
  });
}

test("paginateLinks follows Link rel=next across pages (relative links, createFetch)", async () => {
  const srv = await linkServer(3);
  try {
    const api = createFetch({ baseUrl: srv.url, retry: false });
    const items = await collect(paginateLinks(api, "/things?page=1"));
    assert.deepEqual(items, [11, 12, 21, 22, 31, 32]);
    assert.equal(srv.hits(), 3);
  } finally {
    await srv.close();
  }
});

test("paginateLinks works with plain fetch and extracts { items } bodies", async () => {
  const srv = await linkServer(2, { shape: "object" });
  try {
    const items = await collect(paginateLinks(fetch, `${srv.url}/things?page=1`));
    assert.deepEqual(items, [11, 12, 21, 22]);
  } finally {
    await srv.close();
  }
});

test("paginateLinks: custom getItems, maxItems, maxPages", async () => {
  const srv = await linkServer(5, { shape: "object" });
  try {
    const first3 = await collect(paginateLinks(fetch, `${srv.url}/t?page=1`, { maxItems: 3 }));
    assert.deepEqual(first3, [11, 12, 21]);
    assert.equal(srv.hits(), 2);

    const twoPages = await collect(paginateLinks(fetch, `${srv.url}/t?page=1`, { maxPages: 2, getItems: (d) => d.items.map((n) => n * 2) }));
    assert.deepEqual(twoPages, [22, 24, 42, 44]);
  } finally {
    await srv.close();
  }
});

test("paginateLinks throws HTTPError for a non-2xx page when using plain fetch", async () => {
  const srv = await linkServer(1);
  try {
    await assert.rejects(collect(paginateLinks(fetch, `${srv.url}/t?page=7`)), (e) => e instanceof HTTPError && e.status === 404);
  } finally {
    await srv.close();
  }
});

test("paginateLinks passes init (headers) and the signal to every request, and aborts", async () => {
  const seenHeaders = [];
  let page = 0;
  const srv = await startServer((req, res) => {
    seenHeaders.push(req.headers["x-key"]);
    res.setHeader("content-type", "application/json");
    res.setHeader("link", `</t?page=${++page + 1}>; rel="next"`); // endless, always advancing
    res.end("[1]");
  });
  try {
    const c = new AbortController();
    const got = [];
    await assert.rejects(async () => {
      for await (const x of paginateLinks(fetch, `${srv.url}/t`, { init: { headers: { "x-key": "k" } }, signal: c.signal })) {
        got.push(x);
        if (got.length === 3) c.abort();
      }
    }, (e) => e.name === "AbortError");
    assert.ok(seenHeaders.every((h) => h === "k"));
  } finally {
    await srv.close();
  }
});

test("paginateLinks detects a Link that points back at the same page", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("link", `<${req.url}>; rel="next"`);
    res.end("[1]");
  });
  try {
    await assert.rejects(collect(paginateLinks(fetch, `${srv.url}/loop`)), (e) => e.code === "PAGINATE_STUCK");
  } finally {
    await srv.close();
  }
});

test("paginateLinks explains when it can't find the items", async () => {
  const srv = await startServer((req, res) => res.end('{"weird":true}'));
  try {
    await assert.rejects(collect(paginateLinks(fetch, `${srv.url}/x`)), /getItems/);
  } finally {
    await srv.close();
  }
});

// ---- parseLinkHeader on hostile input ----------------------------------------------

test("parseLinkHeader stays fast on adversarial headers and ignores absurdly long ones", () => {
  const nasty = [
    "<".repeat(60000),
    "<a>" + ";a".repeat(20000) + '"',
    "<a>" + ';a="'.repeat(10000),
    "<a>;a=" + "b".repeat(50000) + ";".repeat(5000),
    "<a>; " + " ".repeat(40000) + "x",
  ];
  const started = Date.now();
  for (const header of nasty) parseLinkHeader(header);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);

  assert.deepEqual(parseLinkHeader('<https://x/next>; rel="next"' + " ".repeat(70000)), {}, "over the 64 KB cap");
  assert.equal(parseLinkHeader('<https://x/next>; rel="next"').next, "https://x/next", "normal input still works");
});
