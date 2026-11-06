// Stream readers, SSE, progress and resumable downloads — src/streams/

export interface DownloadProgress {
  loaded: number;
  total: number | null;
  percent: number | null;
}

export interface WithProgressOptions {
  /** Reject with BodyTooLargeError once more than this many bytes arrive. */
  maxBytes?: number;
  /** Cancels the read; rejects with the signal's reason. */
  signal?: AbortSignal;
}

export class BodyTooLargeError extends Error {
  name: "BodyTooLargeError";
  code: "EBODYTOOLARGE";
  maxBytes: number;
  constructor(maxBytes: number);
}

export function withProgress(
  response: Response,
  onProgress?: (progress: DownloadProgress) => void,
  opts?: WithProgressOptions
): Promise<Uint8Array>;

export interface DownloadResumableOptions {
  fetch?: typeof fetch;
  headers?: HeadersInit;
  /** Consecutive attempts without progress before giving up. Default 5. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
  /** Throws BodyTooLargeError past this many bytes. */
  maxBytes?: number;
  signal?: AbortSignal;
  onRetry?: (err: unknown, attempt: number, delayMs: number, info: { resumeFrom: number }) => void;
}

export function downloadResumable(url: string, opts?: DownloadResumableOptions): Promise<Uint8Array>;

export type StreamSource = Response | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;

export interface StreamOptions {
  signal?: AbortSignal;
  /**
   * Longest line (or, for readSSE, one event's data) in characters before throwing
   * `code: "LINE_TOO_LONG"` — protects against a server that never sends a newline.
   * Default 16 Mi (16 * 1024 * 1024); pass Infinity to disable.
   */
  maxLineLength?: number;
}

export interface SSEEvent {
  event: string;
  data: string;
  id: string;
  retry: number | undefined;
}

export function readLines(source: StreamSource, opts?: StreamOptions): AsyncGenerator<string, void, undefined>;
export function readNDJSON<T = unknown>(
  source: StreamSource,
  opts?: StreamOptions & { skipInvalid?: boolean }
): AsyncGenerator<T, void, undefined>;
export function readSSE(source: StreamSource, opts?: StreamOptions): AsyncGenerator<SSEEvent, void, undefined>;

export interface StreamSSEOptions {
  /** e.g. a createFetch() instance. Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Default "GET". Only GET/HEAD reconnect unless `reconnect: true`. */
  method?: string;
  /** A function is re-evaluated before every (re)connect — handy for refreshing a token. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  body?: BodyInit | null;
  signal?: AbortSignal;
  /** Resume from this id on the very first connect. */
  lastEventId?: string;
  /** Default: true for GET/HEAD, false otherwise. */
  reconnect?: boolean;
  /** Consecutive no-progress connection failures before giving up. Default 10 (Infinity = never). */
  retries?: number;
  /** Base reconnect delay; the server's `retry:` field overrides it. Default 1000. */
  reconnectDelayMs?: number;
  /** Cap on the exponential backoff. Default 30000. */
  maxDelayMs?: number;
  /** End the stream (no reconnect) after this event, e.g. `e => e.data === "[DONE]"`. */
  stopWhen?: (event: SSEEvent) => boolean;
  onOpen?: (info: { connections: number; lastEventId: string }) => void;
  onReconnect?: (info: {
    reason: "error" | "end" | "status";
    error?: unknown;
    status?: number;
    /** Consecutive reconnects without progress (at least 1). */
    attempt: number;
    delayMs: number;
    lastEventId: string;
  }) => void;
}

/** Auto-reconnecting SSE: resumes with Last-Event-ID, honors `retry:` and Retry-After. */
export function streamSSE(url: string, opts?: StreamSSEOptions): AsyncGenerator<SSEEvent, void, undefined>;
