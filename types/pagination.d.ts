// Pagination helpers — src/pagination/

export interface PageContext {
  index: number;
  signal?: AbortSignal;
}

export interface PageResult<T, C = any> {
  items: T[];
  /** Whatever identifies the next page (token, offset, URL...). undefined/null = last page. */
  next?: C | null;
}

export interface Page<T, C = any> {
  items: T[];
  index: number;
  /** The cursor this page was fetched with (undefined for the first, unless `start` was given). */
  cursor: C | undefined;
}

export interface PaginateOptions<C = any> {
  /** The cursor for the first page. */
  start?: C;
  maxPages?: number;
  maxItems?: number;
  signal?: AbortSignal;
}

export type FetchPage<T, C = any> = (cursor: C | undefined, ctx: PageContext) => Promise<PageResult<T, C>>;

/** Yields every item, fetching pages lazily. */
export function paginate<T, C = any>(fetchPage: FetchPage<T, C>, opts?: PaginateOptions<C>): AsyncGenerator<T, void, undefined>;
/** Yields whole pages. */
export function paginatePages<T, C = any>(
  fetchPage: FetchPage<T, C>,
  opts?: Omit<PaginateOptions<C>, "maxItems">
): AsyncGenerator<Page<T, C>, void, undefined>;

export interface PaginateLinksOptions<T = any> {
  /** Default: the body if it's an array, else its `items` / `data` / `results` / `records`. */
  getItems?: (data: any, response: Response) => T[];
  maxPages?: number;
  maxItems?: number;
  signal?: AbortSignal;
  /** Extra options passed to every request. */
  init?: Record<string, any>;
  /**
   * Origins a `Link` may point to. Default: the origin of `url` (or of the createFetch
   * instance's `baseUrl`). Any other origin throws `code: "PAGINATE_CROSS_ORIGIN"`.
   */
  origins?: string[];
}

/** Follows `Link: <...>; rel="next"` headers and yields the items of every page. */
export function paginateLinks<T = any>(
  request: (url: string, init?: any) => Promise<Response>,
  url: string,
  opts?: PaginateLinksOptions<T>
): AsyncGenerator<T, void, undefined>;

/** Parses an RFC 8288 Link header into `{ rel: url }`. Pass `base` to resolve relative URLs. */
export function parseLinkHeader(header: string | null | undefined, base?: string): Record<string, string>;
