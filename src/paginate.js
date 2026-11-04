const { HTTPError } = require("./HTTPError");

/**
 * Parses an RFC 8288 `Link` header (GitHub, GitLab, WordPress... use it for
 * pagination) into `{ rel: url }`. Pass `base` to resolve relative URLs.
 *
 * ```js
 * parseLinkHeader('<https://api.x/items?page=2>; rel="next", <https://api.x/items?page=9>; rel="last"');
 * // { next: "https://api.x/items?page=2", last: "https://api.x/items?page=9" }
 * ```
 *
 * A link with several rels (`rel="next last"`) is listed under each; the first
 * link wins when a rel appears twice. Commas inside `<...>` are handled.
 *
 * @param {string | null | undefined} header
 * @param {string} [base]
 * @returns {Record<string, string>}
 */
function parseLinkHeader(header, base) {
  const links = {};
  if (!header) return links;

  // <url> followed by any number of `; name` / `; name=token` / `; name="quoted, value"` params
  const linkRe = /<([^>]*)>((?:\s*;\s*[^=;,<\s]+(?:\s*=\s*(?:"[^"]*"|[^;,<\s]*))?)*)/g;
  let match;
  while ((match = linkRe.exec(header)) !== null) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(match[2]);
    if (!rel) continue;

    let url = match[1].trim();
    if (base) {
      try {
        url = new URL(url, base).href;
      } catch {
        // leave it as written
      }
    }
    for (const name of (rel[1] ?? rel[2]).toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!(name in links)) links[name] = url;
    }
  }
  return links;
}

function stuckError(message) {
  return Object.assign(new Error(message), { code: "PAGINATE_STUCK" });
}

/**
 * Walks a paginated API page by page. You write `fetchPage(cursor, ctx)` —
 * it returns `{ items, next }`, where `next` is whatever identifies the next
 * page (a cursor token, an offset, a URL...) or `undefined`/`null` on the
 * last page — and you get an async iterator of pages.
 *
 * ```js
 * for await (const { items, index } of paginatePages(async (cursor) => {
 *   const r = await api.json("/users", { query: { cursor, limit: 100 } });
 *   return { items: r.data, next: r.next_cursor };
 * })) { ... }
 * ```
 *
 * A `next` that equals the cursor just used throws `code: "PAGINATE_STUCK"`
 * instead of looping forever.
 *
 * @template T
 * @param {(cursor: any, ctx: { index: number, signal?: AbortSignal }) => Promise<{ items: T[], next?: any }>} fetchPage
 * @param {object} [opts]
 * @param {any} [opts.start] - the cursor for the first page (default undefined)
 * @param {number} [opts.maxPages=Infinity]
 * @param {AbortSignal} [opts.signal]
 * @returns {AsyncGenerator<{ items: T[], index: number, cursor: any }>}
 */
async function* paginatePages(fetchPage, opts = {}) {
  const { start, maxPages = Infinity, signal } = opts;
  let cursor = start;
  let index = 0;

  for (;;) {
    if (index >= maxPages) return;
    signal?.throwIfAborted?.();

    const result = await fetchPage(cursor, { index, signal });
    if (!result || !Array.isArray(result.items)) {
      throw new TypeError("paginate: fetchPage must return { items: array, next?: cursor }");
    }
    yield { items: result.items, index, cursor };

    const next = result.next;
    if (next === undefined || next === null) return;
    if (next === cursor) {
      throw stuckError("paginate: `next` equals the cursor just used, so the page didn't advance — stopping to avoid an infinite loop");
    }
    cursor = next;
    index++;
  }
}

/**
 * Like `paginatePages`, but yields the items one by one. `maxItems` stops
 * early (mid-page) — and since nothing is fetched until you ask for it,
 * `break`-ing out of the loop never fetches a page you didn't need.
 *
 * ```js
 * for await (const user of paginate(fetchUsersPage, { maxItems: 250 })) { ... }
 * ```
 *
 * @template T
 * @param {(cursor: any, ctx: { index: number, signal?: AbortSignal }) => Promise<{ items: T[], next?: any }>} fetchPage
 * @param {object} [opts] - same as paginatePages, plus `maxItems`
 * @param {number} [opts.maxItems=Infinity]
 * @returns {AsyncGenerator<T>}
 */
async function* paginate(fetchPage, opts = {}) {
  const { maxItems = Infinity } = opts;
  if (maxItems <= 0) return;

  let count = 0;
  for await (const page of paginatePages(fetchPage, opts)) {
    for (const item of page.items) {
      yield item;
      if (++count >= maxItems) return;
    }
  }
}

function defaultGetItems(data) {
  if (Array.isArray(data)) return data;
  for (const key of ["items", "data", "results", "records"]) {
    if (data && Array.isArray(data[key])) return data[key];
  }
  throw new TypeError("paginateLinks: couldn't find the items array in the response — pass `getItems(data)`");
}

/**
 * Follows `Link: <...>; rel="next"` headers (GitHub-style) and yields the
 * items of every page. `request` is anything fetch-like — a `createFetch`
 * instance or plain `fetch` (a non-2xx response throws `HTTPError`).
 *
 * ```js
 * for await (const repo of paginateLinks(api, "/orgs/acme/repos?per_page=100")) { ... }
 * ```
 *
 * @param {(url: string, init?: object) => Promise<Response>} request
 * @param {string} url - the first page
 * @param {object} [opts]
 * @param {(data: any, response: Response) => any[]} [opts.getItems] - default: the body if it's an array, else its `items` / `data` / `results` / `records`
 * @param {number} [opts.maxPages=Infinity]
 * @param {number} [opts.maxItems=Infinity]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.init] - extra options passed to every `request`
 */
async function* paginateLinks(request, url, opts = {}) {
  const { getItems = defaultGetItems, init = {}, signal } = opts;

  async function fetchPage(pageUrl) {
    const res = await request(pageUrl, { ...init, signal });
    if (!res.ok) throw new HTTPError(res, { method: init.method || "GET", url: pageUrl });
    const items = getItems(await res.json(), res);
    const next = parseLinkHeader(res.headers.get("link"), pageUrl).next;
    return { items, next };
  }

  yield* paginate(fetchPage, { ...opts, start: url });
}

module.exports = { paginate, paginatePages, paginateLinks, parseLinkHeader };
