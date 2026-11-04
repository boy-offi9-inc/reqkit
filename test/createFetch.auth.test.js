const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./_server");
const { createFetch, HTTPError } = require("../src");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Server that accepts exactly one bearer token, which tests can change.
function authServer(state, { delay401 = {} } = {}) {
  return startServer((req, res) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const reply = () => {
        if (token === state.valid) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, token, body: raw }));
        } else {
          res.statusCode = 401;
          res.end("unauthorized");
        }
      };
      const d = delay401[req.url];
      if (d && token !== state.valid) setTimeout(reply, d);
      else reply();
    });
  });
}

function makeAuth(state, overrides = {}) {
  const calls = { refresh: 0, getToken: 0 };
  const auth = {
    getToken: async () => (calls.getToken++, state.token),
    refresh: async () => {
      calls.refresh++;
      await sleep(40);
      state.token = "fresh";
      state.valid = "fresh";
    },
    ...overrides,
  };
  return { auth, calls };
}

test("auth attaches `Authorization: Bearer <token>` from getToken", async () => {
  const state = { token: "good", valid: "good" };
  const srv = await authServer(state);
  try {
    const { auth, calls } = makeAuth(state);
    const api = createFetch({ baseUrl: srv.url, auth });
    assert.equal((await api.json("/me")).token, "good");
    assert.equal(calls.refresh, 0);
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("auth: a 401 refreshes the token once and replays the request", async () => {
  const state = { token: "expired", valid: "fresh" };
  const srv = await authServer(state);
  try {
    const { auth, calls } = makeAuth(state);
    const api = createFetch({ baseUrl: srv.url, auth });
    const data = await api.json("/me");
    assert.equal(data.token, "fresh");
    assert.equal(calls.refresh, 1);
    assert.equal(srv.hits(), 2, "rejected once, then replayed");
  } finally {
    await srv.close();
  }
});

test("auth: concurrent 401s share ONE refresh (single-flight)", async () => {
  const state = { token: "expired", valid: "fresh" };
  const srv = await authServer(state);
  try {
    const { auth, calls } = makeAuth(state);
    const api = createFetch({ baseUrl: srv.url, auth });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => api.json(`/r${i}`)));
    assert.ok(results.every((r) => r.token === "fresh"));
    assert.equal(calls.refresh, 1, "six rejected requests, one refresh");
    assert.equal(srv.hits(), 12);
  } finally {
    await srv.close();
  }
});

test("auth: a request that was rejected AFTER someone else refreshed reuses the new token without refreshing again", async () => {
  const state = { token: "expired", valid: "fresh" };
  // /slow's 401 only arrives after the refresh triggered by /fast has finished
  const srv = await authServer(state, { delay401: { "/slow": 150 } });
  try {
    const { auth, calls } = makeAuth(state);
    const api = createFetch({ baseUrl: srv.url, auth });
    const [fast, slow] = await Promise.all([api.json("/fast"), api.json("/slow")]);
    assert.equal(fast.token, "fresh");
    assert.equal(slow.token, "fresh");
    assert.equal(calls.refresh, 1, "the late 401 saw the already-refreshed token");
  } finally {
    await srv.close();
  }
});

test("auth: gives up after one refresh when the replay is rejected too (no loops)", async () => {
  const state = { token: "expired", valid: "never-matches" };
  const srv = await authServer(state);
  try {
    const { auth, calls } = makeAuth(state, {
      refresh: async () => {
        state.token = "still-wrong";
        calls.refresh++;
      },
    });
    const api = createFetch({ baseUrl: srv.url, auth });
    await assert.rejects(api("/me"), (e) => e instanceof HTTPError && e.status === 401);
    assert.equal(calls.refresh, 1);
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("auth: refresh() can return the new token directly", async () => {
  const state = { token: "expired", valid: "direct" };
  const srv = await authServer(state);
  try {
    const { auth } = makeAuth(state, { refresh: async () => "direct" });
    const api = createFetch({ baseUrl: srv.url, auth });
    assert.equal((await api.json("/me")).token, "direct");
  } finally {
    await srv.close();
  }
});

test("auth: errors thrown by refresh() reach every waiting caller", async () => {
  const state = { token: "expired", valid: "x" };
  const srv = await authServer(state);
  try {
    const { auth } = makeAuth(state, {
      refresh: async () => {
        await sleep(20);
        throw new Error("refresh token revoked");
      },
    });
    const api = createFetch({ baseUrl: srv.url, auth });
    const settled = await Promise.allSettled([api("/a"), api("/b"), api("/c")]);
    assert.ok(settled.every((s) => s.status === "rejected" && /revoked/.test(s.reason.message)));

    // …and a later request may try again (the failed refresh isn't cached)
    state.valid = "retry-ok";
    auth.refresh = async () => "retry-ok";
    assert.equal((await api.json("/d")).token, "retry-ok");
  } finally {
    await srv.close();
  }
});

test("auth: replays request bodies (POST) after refreshing", async () => {
  const state = { token: "expired", valid: "fresh" };
  const srv = await authServer(state);
  try {
    const { auth } = makeAuth(state);
    const api = createFetch({ baseUrl: srv.url, auth });
    const data = await api.json("/orders", { method: "POST", json: { item: 1 } });
    assert.equal(data.body, '{"item":1}');
    assert.equal(srv.hits(), 2);
  } finally {
    await srv.close();
  }
});

test("auth: a stream body can't be replayed, so the 401 is surfaced", async () => {
  const state = { token: "expired", valid: "fresh" };
  const srv = await authServer(state);
  try {
    const { auth, calls } = makeAuth(state);
    const api = createFetch({ baseUrl: srv.url, auth });
    const body = new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array([1])), c.close()) });
    await assert.rejects(api("/up", { method: "POST", body, duplex: "half" }), (e) => e instanceof HTTPError && e.status === 401);
    assert.equal(calls.refresh, 0);
  } finally {
    await srv.close();
  }
});

test("auth: a caller-supplied Authorization header wins and is never refreshed", async () => {
  const state = { token: "managed", valid: "managed" };
  const srv = await authServer(state);
  try {
    const { auth, calls } = makeAuth(state);
    const api = createFetch({ baseUrl: srv.url, auth });
    await assert.rejects(api("/me", { headers: { authorization: "Bearer mine" } }), (e) => e.status === 401);
    assert.equal(calls.refresh, 0);
    assert.equal(calls.getToken, 0, "didn't even ask for a token");
  } finally {
    await srv.close();
  }
});

test("auth: custom header, scheme and shouldRefresh", async () => {
  const seen = [];
  const srv = await startServer((req, res) => {
    seen.push(req.headers["x-api-key"]);
    if (req.headers["x-api-key"] === "k2") return res.end("ok");
    res.statusCode = 419; // "session expired"
    res.end("expired");
  });
  try {
    let token = "k1";
    const api = createFetch({
      baseUrl: srv.url,
      auth: {
        header: "X-API-Key",
        scheme: "",
        getToken: () => token,
        refresh: () => (token = "k2"),
        shouldRefresh: (res) => res.status === 419,
      },
    });
    assert.equal(await (await api("/x")).text(), "ok");
    assert.deepEqual(seen, ["k1", "k2"]);
  } finally {
    await srv.close();
  }
});

test("auth: extend() children sharing the same auth object share one refresh", async () => {
  const state = { token: "expired", valid: "fresh" };
  const srv = await authServer(state);
  try {
    const { auth, calls } = makeAuth(state);
    const api = createFetch({ baseUrl: srv.url, auth });
    const child = api.extend({ timeout: 5000 });
    await Promise.all([api.json("/a"), child.json("/b"), child.json("/c")]);
    assert.equal(calls.refresh, 1);
  } finally {
    await srv.close();
  }
});

test("auth: works together with the cache (entries are keyed per token)", async () => {
  const state = { token: "expired", valid: "fresh" };
  const srv = await authServer(state);
  try {
    const { auth, calls } = makeAuth(state);
    const api = createFetch({ baseUrl: srv.url, auth, cache: { ttl: 5000 } });
    assert.equal((await api.json("/me")).token, "fresh");
    await sleep(15);
    const hitsAfterFirst = srv.hits();
    assert.equal((await api.json("/me")).token, "fresh");
    assert.equal(srv.hits(), hitsAfterFirst, "second call served from cache under the refreshed token");
    assert.equal(calls.refresh, 1);
  } finally {
    await srv.close();
  }
});
