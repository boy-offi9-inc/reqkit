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

/**
 * Async-iterates the text lines of a streamed body. Handles \n, \r\n and \r,
 * multi-byte characters split across chunks, and a leading BOM.
 *
 * ```js
 * for await (const line of readLines(response)) console.log(line);
 * ```
 *
 * @param {Response | ReadableStream | AsyncIterable<Uint8Array>} source
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {AsyncGenerator<string>}
 */
async function* readLines(source, opts = {}) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let first = true;

  for await (const chunk of chunks(source, opts.signal)) {
    buffer += decoder.decode(chunk, { stream: true });
    if (first && buffer.length > 0) {
      buffer = buffer.replace(/^\uFEFF/, "");
      first = false;
    }

    let pos = 0;
    for (;;) {
      const rest = buffer.slice(pos);
      const i = rest.search(/\r\n|\n|\r/);
      if (i === -1) break;
      // A trailing "\r" might be the first half of "\r\n" — wait for more data.
      if (rest[i] === "\r" && i === rest.length - 1) break;
      yield rest.slice(0, i);
      pos += i + (rest.startsWith("\r\n", i) ? 2 : 1);
    }
    buffer = buffer.slice(pos);
  }

  buffer += decoder.decode();
  if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
  if (buffer.length > 0) yield buffer;
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
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function* readSSE(source, opts = {}) {
  let event = "";
  let data = [];
  let retry;
  let lastId = "";

  for await (const line of readLines(source, opts)) {
    if (line === "") {
      if (data.length > 0) yield { event: event || "message", data: data.join("\n"), id: lastId, retry };
      event = "";
      data = [];
      retry = undefined;
      continue;
    }
    if (line.startsWith(":")) continue;

    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") {
      if (!value.includes("\0")) lastId = value;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) retry = Number(value);
    }
  }
}

module.exports = { readLines, readNDJSON, readSSE };
