const encoder = new TextEncoder();

// Yields Uint8Array chunks from a fetch Response, a web ReadableStream, or any
// async iterable (e.g. a Node Readable). Cancels the underlying stream when
// the consumer stops early or the signal aborts, so the connection is freed.
async function* chunks(source, signal) {
  let body = source;
  if (body && typeof body.getReader !== "function" && "body" in body) body = body.body; // a Response
  if (body === null || body === undefined) return;
  signal?.throwIfAborted?.();

  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const onAbort = () => reader.cancel(signal.reason).catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        signal?.throwIfAborted?.(); // cancel() makes read() resolve as done — don't mistake that for the end
        if (done) return;
        yield value;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      reader.cancel().catch(() => {});
    }
  } else if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      signal?.throwIfAborted?.();
      yield typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    }
  } else {
    throw new TypeError("reqkit streams: expected a Response, a ReadableStream or an async iterable");
  }
}

const DEFAULT_MAX_LINE_LENGTH = 16 * 1024 * 1024;

function lineTooLong(limit) {
  return Object.assign(
    new Error(`reqkit streams: a line exceeded ${limit} characters without a line break (raise \`maxLineLength\` if that's expected)`),
    { code: "LINE_TOO_LONG" }
  );
}

/**
 * Async-iterates the text lines of a streamed body. Handles \n, \r\n and \r,
 * multi-byte characters split across chunks, and a leading BOM.
 *
 * Runs in linear time and bounded memory: only newly arrived text is scanned,
 * and a "line" longer than `maxLineLength` characters (default 16 Mi — a
 * server that never sends a newline) throws `code: "LINE_TOO_LONG"` instead
 * of buffering forever.
 *
 * ```js
 * for await (const line of readLines(response)) console.log(line);
 * ```
 *
 * @param {Response | ReadableStream | AsyncIterable<Uint8Array>} source
 * @param {{ signal?: AbortSignal, maxLineLength?: number }} [opts]
 * @returns {AsyncGenerator<string>}
 */
async function* readLines(source, opts = {}) {
  const { maxLineLength = DEFAULT_MAX_LINE_LENGTH } = opts;
  const decoder = new TextDecoder("utf-8");
  const terminator = /[\r\n]/g;

  let parts = []; // pieces of the line being assembled (no terminators in them)
  let partsLength = 0;
  let skipLF = false; // the previous line ended with "\r", so a leading "\n" belongs to it
  let first = true;

  for await (const chunk of chunks(source, opts.signal)) {
    let text = decoder.decode(chunk, { stream: true });
    if (first && text.length > 0) {
      text = text.replace(/^\uFEFF/, "");
      first = false;
    }

    let start = 0;
    terminator.lastIndex = 0;
    let match;
    while ((match = terminator.exec(text)) !== null) {
      const ch = match[0];
      if (ch === "\n" && skipLF && match.index === start) {
        skipLF = false; // the "\n" of a "\r\n" pair — swallow it
        start = match.index + 1;
        continue;
      }
      skipLF = false;

      const piece = text.slice(start, match.index);
      if (partsLength + piece.length > maxLineLength) throw lineTooLong(maxLineLength);
      const line = parts.length > 0 ? parts.join("") + piece : piece;
      parts = [];
      partsLength = 0;
      yield line;

      start = match.index + 1;
      skipLF = ch === "\r";
    }

    if (start < text.length) {
      const rest = text.slice(start);
      partsLength += rest.length;
      if (partsLength > maxLineLength) throw lineTooLong(maxLineLength);
      parts.push(rest);
      skipLF = false;
    }
  }

  const tail = parts.join("") + decoder.decode();
  if (tail.length > 0) yield tail;
}

/**
 * Async-iterates parsed JSON values from a newline-delimited JSON stream
 * (NDJSON / JSON Lines). Blank lines are skipped. A malformed line throws a
 * SyntaxError naming the line, unless `skipInvalid` is true.
 *
 * @param {Response | ReadableStream | AsyncIterable<Uint8Array>} source
 * @param {{ signal?: AbortSignal, skipInvalid?: boolean }} [opts]
 */
async function* readNDJSON(source, opts = {}) {
  let lineNo = 0;
  for await (const line of readLines(source, opts)) {
    lineNo++;
    if (line.trim() === "") continue;
    try {
      yield JSON.parse(line);
    } catch (err) {
      if (opts.skipInvalid) continue;
      throw new SyntaxError(`readNDJSON: invalid JSON on line ${lineNo}: ${err.message}`);
    }
  }
}

/**
 * Async-iterates Server-Sent Events (text/event-stream) as
 * `{ event, data, id, retry }`, following the spec: multi-line `data:` is
 * joined with "\n", comments (`:`) are ignored, `event` defaults to
 * "message", `id` carries over between events, and an event cut off by the end
 * of the stream is discarded. Great for LLM token streams.
 *
 * ```js
 * for await (const { data } of readSSE(response)) {
 *   if (data === "[DONE]") break;
 *   console.log(JSON.parse(data));
 * }
 * ```
 *
 * @param {Response | ReadableStream | AsyncIterable<Uint8Array>} source
 * @param {{ signal?: AbortSignal, maxLineLength?: number }} [opts] - `maxLineLength` also caps the data of a single event
 */
async function* readSSE(source, opts = {}) {
  const maxEventLength = opts.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  let event = "";
  let data = [];
  let dataLength = 0;
  let retry;
  let lastId = "";

  for await (const line of readLines(source, opts)) {
    if (line === "") {
      if (data.length > 0) yield { event: event || "message", data: data.join("\n"), id: lastId, retry };
      event = "";
      data = [];
      dataLength = 0;
      retry = undefined;
      continue;
    }
    if (line.startsWith(":")) continue;

    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") {
      dataLength += value.length + 1;
      if (dataLength > maxEventLength) throw lineTooLong(maxEventLength);
      data.push(value);
    }
    else if (field === "id") {
      if (!value.includes("\0")) lastId = value;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) retry = Number(value);
    }
  }
}

module.exports = { readLines, readNDJSON, readSSE };
