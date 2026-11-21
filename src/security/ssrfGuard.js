// SSRF guard: refuse requests whose target is a private, loopback, link-local
// or cloud-metadata address. Opt-in per `createFetch` instance via
// `ssrfGuard: true` (or an object of options). The guard checks
//
//   1. the URL scheme (only http/https),
//   2. literal IP hosts (loopback, RFC 1918, link-local 169.254/16 incl.
//      cloud-metadata 169.254.169.254, 0.0.0.0, IPv6 loopback / unique-local /
//      link-local, IPv4-mapped IPv6),
//   3. resolved DNS addresses (Node only; where `node:dns` is unavailable the
//      literal checks above still apply), on EVERY hop,
//   4. every redirect hop — with the guard on, redirects are followed by
//      reqkit (`redirect: "manual"`) so a redirect cannot silently hop into an
//      internal network.
//
// The guard is OFF by default: it changes redirect semantics and can break
// legitimate localhost development. Turn it on for servers that fetch
// user-supplied URLs.

const DEFAULT_MAX_REDIRECTS = 5;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
]);

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10 (Tailscale etc.)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
  // IPv4-mapped: ::ffff:a.b.c.d (dotted) or the hex form ::ffff:a00:1 that
  // WHATWG URL canonicalization can produce. Decode both.
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateIPv4(dotted[1]);
  const hexGroups = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexGroups) {
    const hi = parseInt(hexGroups[1], 16);
    const lo = parseInt(hexGroups[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

function isPrivateLiteral(host) {
  if (!host) return false;
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTNAMES.has(bare)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) return isPrivateIPv4(bare);
  if (bare.includes(":")) return isPrivateIPv6(bare);
  return false;
}

function isPublicIPv4Literal(host) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) && !isPrivateIPv4(host);
}

async function resolveIps(hostname) {
  // Node only; any other runtime just gets the literal checks.
  try {
    const dns = await import("node:dns").then((m) => m.promises ?? m);
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    return results.map((r) => r.address);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND") return null; // no resolver available
    // Any other resolution failure (ENOTFOUND, EAI_AGAIN, ...) fails closed:
    // the caller sees the underlying error via the guard, never a silent pass.
    err.ssrfHostname = hostname;
    throw err;
  }
}

class SSRFBlockedError extends Error {
  constructor(reason, url) {
    super(`reqkit ssrfGuard: blocked request to ${url} (${reason})`);
    this.name = "SSRFBlockedError";
    this.code = "SSRF_BLOCKED";
    this.reason = reason;
    this.url = url;
  }
}

function createSsrfGuard(opts = {}) {
  const {
    allowPrivate = false, // master bypass for dev environments
    allowHosts = [], // exact hostnames to allow even if private (e.g. "localhost" in dev)
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = opts;
  const allowed = new Set(allowHosts.map((h) => String(h).toLowerCase()));

  function assertUrlAllowed(urlStr) {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      throw new SSRFBlockedError("unparseable-url", urlStr);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SSRFBlockedError(`scheme-${url.protocol.replace(":", "")}`, urlStr);
    }
    const host = url.hostname.toLowerCase();
    if (allowed.has(host) || allowPrivate) return;
    if (isPrivateLiteral(host)) {
      throw new SSRFBlockedError("private-address", urlStr);
    }
    return { url, host };
  }

  async function assertResolvableAllowed(urlStr) {
    const checked = assertUrlAllowed(urlStr);
    if (!checked || allowPrivate) return;
    const { host } = checked;
    // A public IPv4 literal doesn't need DNS; hostnames and IPv6 do.
    if (!isPublicIPv4Literal(host)) {
      const ips = await resolveIps(host);
      if (ips && ips.length > 0) {
        for (const ip of ips) {
          if (isPrivateLiteral(ip)) {
            throw new SSRFBlockedError("resolves-to-private-address", urlStr);
          }
        }
      }
    }
  }

  // A guarded fetch: validates the initial URL, then follows redirects itself
  // so every hop is re-checked (fetch with redirect:follow would hop opaquely).
  function guardedFetch(fetchImpl) {
    return async function guarded(input, init) {
      const firstUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      await assertResolvableAllowed(firstUrl);
      let currentUrl = firstUrl;
      let currentInit = init;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const hopInit = hop === 0 ? currentInit : { ...currentInit, redirect: "manual" };
        const response = await fetchImpl(hop === 0 ? input : currentUrl, hopInit);
        const status = response.status;
        if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) {
          return response;
        }
        const location = response.headers.get("location");
        // Consume the body of the redirect response so the socket is freed.
        try { await response.arrayBuffer(); } catch { /* ignore */ }
        if (!location) return response;
        if (hop === maxRedirects) {
          throw new SSRFBlockedError("too-many-redirects", currentUrl);
        }
        const nextUrl = new URL(location, currentUrl).href;
        await assertResolvableAllowed(nextUrl);
        // Per the Fetch spec: 303 always becomes GET; 301/302 turn a POST into
        // GET (other methods are preserved). 307/308 keep method and body.
        const method = (currentInit?.method || "GET").toUpperCase();
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
          currentInit = { ...currentInit, method: "GET", body: undefined };
        }
        currentUrl = nextUrl;
      }
      throw new SSRFBlockedError("too-many-redirects", firstUrl);
    };
  }

  return { assertUrlAllowed, assertResolvableAllowed, guardedFetch, SSRFBlockedError };
}

module.exports = { createSsrfGuard, SSRFBlockedError };
