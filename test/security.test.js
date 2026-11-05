const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./_server");
const { createFetch, paginateLinks } = require("../src");

function recorder() {
  const seen = [];
  return {
    seen,
    srv: startServer((req, res) => {
      seen.push({ authorization: req.headers.authorization, cookie: req.headers.cookie, apiKey: req.headers["x-api-key"], client: req.headers["x-client"], url: req.url });
      res.end("ok");
    }),
  };
}
const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

test("default credentials are NOT sent when an absolute URL points at another origin", async () => {
  const home = recorder();
  const other = recorder();
  const [homeSrv, otherSrv] = [await home.srv, await other.srv];
  try {
    const api = createFetch({
      baseUrl: homeSrv.url,
      headers: { authorization: "Bearer DEFAULT", cookie: "session=abc", "x-api-key": "KEY", "x-client": "reqkit-test" },
      retry: false,
    });
    await api("/mine");
    await api(`${otherSrv.url}/theirs`);

    assert.deepEqual(home.seen[0], { authorization: "Bearer DEFAULT", cookie: "session=abc", apiKey: "KEY", client: "reqkit-test", url: "/mine" });
    assert.deepEqual(other.seen[0], { authorization: undefined, cookie: undefined, apiKey: undefined, client: "reqkit-test", url: "/theirs" }, "credentials stripped, harmless headers kept");
  } finally {
    await homeSrv.close();
    await otherSrv.close();
  }
});

test("headers passed for a specific call are deliberate and always sent", async () => {
  const home = recorder();
  const other = recorder();
  const [homeSrv, otherSrv] = [await home.srv, await other.srv];
  try {
    const api = createFetch({ baseUrl: homeSrv.url, retry: false });
    await api(`${otherSrv.url}/x`, { headers: { authorization: "Bearer EXPLICIT" } });
    assert.equal(other.seen[0].authorization, "Bearer EXPLICIT");
  } finally {
    await homeSrv.close();
    await otherSrv.close();
  }
});

test("the `auth` token is only attached for the baseUrl origin", async () => {
  const home = recorder();
  const other = recorder();
  const [homeSrv, otherSrv] = [await home.srv, await other.srv];
  try {
    let asked = 0;
    const api = createFetch({ baseUrl: homeSrv.url, auth: { getToken: () => (asked++, "SECRET"), refresh() {} }, retry: false });
    await api("/mine");
    await api(`${otherSrv.url}/theirs`);
    assert.equal(home.seen[0].authorization, "Bearer SECRET");
    assert.equal(other.seen[0].authorization, undefined);
    assert.equal(asked, 1, "getToken wasn't even called for the foreign origin");
  } finally {
    await homeSrv.close();
    await otherSrv.close();
  }
});

test("a custom auth header name is stripped cross-origin too", async () => {
  const home = recorder();
  const other = recorder();
  const [homeSrv, otherSrv] = [await home.srv, await other.srv];
  try {
    const api = createFetch({ baseUrl: homeSrv.url, headers: { "x-session-secret": "s3" }, auth: { header: "x-session-secret", getToken: () => "t", refresh() {} }, retry: false });
    let leaked;
    const spy = await startServer((req, res) => ((leaked = req.headers["x-session-secret"]), res.end("ok")));
    await api(`${spy.url}/x`);
    assert.equal(leaked, undefined);
    await spy.close();
  } finally {
    await homeSrv.close();
    await otherSrv.close();
  }
});

test("trustedOrigins opts extra origins in", async () => {
  const home = recorder();
  const cdn = recorder();
  const [homeSrv, cdnSrv] = [await home.srv, await cdn.srv];
  try {
    const api = createFetch({
      baseUrl: homeSrv.url,
      trustedOrigins: [cdnSrv.url],
      auth: { getToken: () => "SECRET", refresh() {} },
      retry: false,
    });
    await api(`${cdnSrv.url}/asset`);
    assert.equal(cdn.seen[0].authorization, "Bearer SECRET");
  } finally {
    await homeSrv.close();
    await cdnSrv.close();
  }
});

test("without a baseUrl or trustedOrigins there's nothing to compare against, so behavior is unchanged", async () => {
  const any = recorder();
  const srv = await any.srv;
  try {
    const api = createFetch({ headers: { authorization: "Bearer D" }, retry: false });
    await api(`${srv.url}/x`);
    assert.equal(any.seen[0].authorization, "Bearer D");
  } finally {
    await srv.close();
  }
});

test("extend() children keep the same credential scoping", async () => {
  const home = recorder();
  const other = recorder();
  const [homeSrv, otherSrv] = [await home.srv, await other.srv];
  try {
    const child = createFetch({ baseUrl: homeSrv.url, headers: { authorization: "Bearer D" }, retry: false }).extend({ timeout: 5000 });
    await child(`${otherSrv.url}/x`);
    assert.equal(other.seen[0].authorization, undefined);
  } finally {
    await homeSrv.close();
    await otherSrv.close();
  }
});

// ---- paginateLinks: a malicious Link must not steer requests elsewhere -------------

test("paginateLinks refuses a Link that points at another origin (and sends nothing there)", async () => {
  const victim = recorder();
  const victimSrv = await victim.srv;
  const origin = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("link", `<${victimSrv.url}/steal>; rel="next"`);
    res.end("[1]");
  });
  try {
    await assert.rejects(
      collect(paginateLinks(fetch, `${origin.url}/p`, { init: { headers: { authorization: "Bearer SECRET" } } })),
      (e) => e.code === "PAGINATE_CROSS_ORIGIN"
    );
    assert.equal(victim.seen.length, 0, "the third party never saw a request");
  } finally {
    await origin.close();
    await victimSrv.close();
  }
});

test("paginateLinks follows same-origin absolute links, and `origins` can allow others", async () => {
  const b = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("[2]");
  });
  const a = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/p1") res.setHeader("link", `<http://${req.headers.host}/p2>; rel="next"`); // same origin, absolute
    if (req.url === "/p2") res.setHeader("link", `<${b.url}/other>; rel="next"`); // cross origin
    res.end("[1]");
  });
  try {
    await assert.rejects(collect(paginateLinks(fetch, `${a.url}/p1`)), (e) => e.code === "PAGINATE_CROSS_ORIGIN");
    const items = await collect(paginateLinks(fetch, `${a.url}/p1`, { origins: [a.url, b.url] }));
    assert.deepEqual(items, [1, 1, 2]);
  } finally {
    await a.close();
    await b.close();
  }
});

test("paginateLinks with a createFetch instance uses its baseUrl as the allowed origin", async () => {
  const victim = recorder();
  const victimSrv = await victim.srv;
  const origin = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("link", `<${victimSrv.url}/steal>; rel="next"`);
    res.end("[1]");
  });
  try {
    const api = createFetch({ baseUrl: origin.url, retry: false });
    assert.equal(api.baseUrl, origin.url);
    await assert.rejects(collect(paginateLinks(api, "/p")), (e) => e.code === "PAGINATE_CROSS_ORIGIN");
    assert.equal(victim.seen.length, 0);
  } finally {
    await origin.close();
    await victimSrv.close();
  }
});
