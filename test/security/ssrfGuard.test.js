const test = require("node:test");
const assert = require("node:assert");
const { createFetch, createSsrfGuard, SSRFBlockedError } = require("../../src/index.js");

const okFetch = async () => new Response("ok");

test("ssrfGuard blocks literal private targets", async () => {
  const client = createFetch({ ssrfGuard: true, fetch: okFetch });
  const blocked = [
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://10.1.2.3/x",
    "http://172.16.0.9/x",
    "http://192.168.0.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/x",
    "http://[::1]/x",
    "http://[fd12::1]/x",
    "http://[fe80::1]/x",
    "http://[::ffff:10.0.0.1]/x",
    "http://metadata.google.internal/computeMetadata/v1/",
  ];
  for (const url of blocked) {
    await assert.rejects(client(url), (err) => {
      assert.ok(err instanceof SSRFBlockedError, url + " -> " + err.name);
      assert.equal(err.code, "SSRF_BLOCKED");
      assert.equal(err.reason, "private-address");
      return true;
    });
  }
});

test("ssrfGuard rejects non-http schemes", async () => {
  const client = createFetch({ ssrfGuard: true, fetch: okFetch });
  await assert.rejects(client("file:///etc/passwd"), (err) => {
    assert.ok(err instanceof SSRFBlockedError);
    assert.equal(err.reason, "scheme-file");
    return true;
  });
});

test("ssrfGuard allows public targets and passes init through", async () => {
  let seen;
  const client = createFetch({
    ssrfGuard: true,
    fetch: async (input, init) => {
      seen = { url: String(input), method: init?.method, headers: init?.headers };
      return new Response("fine");
    },
  });
  const res = await client("http://93.184.216.34/pub", { method: "POST", headers: { "x-a": "b" } });
  assert.equal(await res.text(), "fine");
  assert.equal(seen.method, "POST");
  assert.equal(new Headers(seen.headers).get("x-a"), "b");
});

test("ssrfGuard re-checks every redirect hop and blocks the private one", async () => {
  const hops = [];
  const fetch = async (input) => {
    hops.push(String(input));
    if (String(input).endsWith("/hop1")) {
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/steal" } });
    }
    return new Response("done");
  };
  const client = createFetch({ ssrfGuard: true, fetch });
  await assert.rejects(client("http://93.184.216.34/hop1"), (err) => {
    assert.ok(err instanceof SSRFBlockedError);
    assert.equal(err.reason, "private-address");
    return true;
  });
  assert.equal(hops.length, 1, "blocked hop must not reach the transport");
});

test("ssrfGuard follows safe redirects (302 same-origin, 303 POST->GET)", async () => {
  const calls = [];
  const fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method || "GET" });
    if (String(input).endsWith("/start")) {
      return new Response(null, { status: 303, headers: { location: "/finish" } });
    }
    return new Response("arrived:" + (init?.method || "GET"));
  };
  const client = createFetch({ ssrfGuard: true, fetch });
  const res = await client("http://93.184.216.34/start", { method: "POST" });
  assert.equal(await res.text(), "arrived:GET");
  assert.deepEqual(calls.map((c) => c.method), ["POST", "GET"]);
});

test("ssrfGuard stops at too many redirects", async () => {
  const fetch = async () => new Response(null, { status: 302, headers: { location: "/next" } });
  const client = createFetch({ ssrfGuard: true, fetch });
  await assert.rejects(client("http://93.184.216.34/loop"), (err) => {
    assert.ok(err instanceof SSRFBlockedError);
    assert.equal(err.reason, "too-many-redirects");
    return true;
  });
});

test("ssrfGuard fails closed when DNS resolution fails", async () => {
  const client = createFetch({ ssrfGuard: true, fetch: okFetch });
  await assert.rejects(client("http://definitely-not-a-real-host-reqkit.invalid/x"), (err) => {
    assert.equal(err.code, "ENOTFOUND");
    return true;
  });
});

test("ssrfGuard allowHosts and allowPrivate bypasses", async () => {
  const dev = createFetch({ ssrfGuard: { allowHosts: ["localhost"] }, fetch: okFetch });
  const res = await dev("http://localhost/dev");
  assert.equal(res.status, 200);

  const dev2 = createFetch({ ssrfGuard: { allowPrivate: true }, fetch: okFetch });
  const res2 = await dev2("http://127.0.0.1/dev");
  assert.equal(res2.status, 200);
});

test("guard is opt-in: default createFetch still reaches localhost mocks", async () => {
  const client = createFetch({ fetch: okFetch });
  const res = await client("http://localhost/plain");
  assert.equal(res.status, 200);
});

test("standalone createSsrfGuard literal checks", () => {
  const guard = createSsrfGuard();
  assert.throws(() => guard.assertUrlAllowed("http://10.0.0.1/x"), SSRFBlockedError);
  assert.doesNotThrow(() => guard.assertUrlAllowed("https://example.com/x"));
  assert.throws(() => guard.assertUrlAllowed("gopher://example.com"), SSRFBlockedError);
});
