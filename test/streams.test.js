const test = require("node:test");
const assert = require("node:assert/strict");
const { readLines, readNDJSON, readSSE } = require("../src/streams");

const enc = new TextEncoder();

function streamOf(parts) {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < parts.length) controller.enqueue(typeof parts[i] === "string" ? enc.encode(parts[i++]) : parts[i++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  stream.wasCancelled = () => cancelled;
  return stream;
}
const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

test("readLines splits on \\n, \\r\\n and \\r, across chunk boundaries", async () => {
  const lines = await collect(readLines(streamOf(["a\nb\r", "\nc\rd", "\n", "last"])));
  assert.deepEqual(lines, ["a", "b", "c", "d", "last"]);
});

test("readLines keeps empty lines and drops nothing at the end", async () => {
  assert.deepEqual(await collect(readLines(streamOf(["a\n\nb\n"]))), ["a", "", "b"]);
  assert.deepEqual(await collect(readLines(streamOf(["x\r"]))), ["x"]);
});

test("readLines decodes multi-byte characters split across chunks and strips a BOM", async () => {
  const bytes = enc.encode("\uFEFFhé😀\n");
  const lines = await collect(readLines(streamOf([bytes.slice(0, 4), bytes.slice(4, 8), bytes.slice(8)])));
  assert.deepEqual(lines, ["hé😀"]);
});

test("readLines accepts a Response, and a null-body Response yields nothing", async () => {
  assert.deepEqual(await collect(readLines(new Response("one\ntwo"))), ["one", "two"]);
  assert.deepEqual(await collect(readLines(new Response(null, { status: 204 }))), []);
});

test("readLines accepts async iterables of strings/bytes (Node streams)", async () => {
  const { Readable } = require("node:stream");
  assert.deepEqual(await collect(readLines(Readable.from(["a\nb", "\nc"]))), ["a", "b", "c"]);
});

test("readLines cancels the stream when the consumer stops early", async () => {
  const stream = streamOf(["1\n", "2\n", "3\n"]);
  for await (const line of readLines(stream)) {
    if (line === "1") break;
  }
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(stream.wasCancelled(), true);
});

test("readLines rejects when the signal aborts mid-stream", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode("tick\n"));
      return new Promise((r) => setTimeout(r, 10));
    },
  });
  const seen = [];
  await assert.rejects(async () => {
    for await (const line of readLines(stream, { signal: controller.signal })) {
      seen.push(line);
      if (seen.length === 2) controller.abort();
    }
  }, (e) => e.name === "AbortError");
});

test("readLines rejects a non-stream source", async () => {
  await assert.rejects(collect(readLines(42)), TypeError);
});

test("readNDJSON parses lines, skips blanks, reports the bad line number", async () => {
  assert.deepEqual(await collect(readNDJSON(streamOf(['{"a":1}\n\n{"a":2}\n']))), [{ a: 1 }, { a: 2 }]);
  await assert.rejects(collect(readNDJSON(streamOf(['{"a":1}\nnope\n']))), /line 2/);
  assert.deepEqual(await collect(readNDJSON(streamOf(['{"a":1}\nnope\n{"a":3}']), { skipInvalid: true })), [{ a: 1 }, { a: 3 }]);
});

test("readSSE parses events per spec", async () => {
  const text =
    ": a comment\n" +
    "data: hello\n\n" +
    "event: update\nid: 7\ndata: line1\ndata: line2\n\n" +
    "data: next\nretry: 1500\n\n" +
    "data\n\n" + // empty data field → dispatches ""
    "event: ignored-without-data\n\n" +
    "data: cut off at the end";
  const events = await collect(readSSE(streamOf([text.slice(0, 30), text.slice(30)])));
  assert.deepEqual(events, [
    { event: "message", data: "hello", id: "", retry: undefined },
    { event: "update", data: "line1\nline2", id: "7", retry: undefined },
    { event: "message", data: "next", id: "7", retry: 1500 }, // id carries over
    { event: "message", data: "", id: "7", retry: undefined },
  ]);
});

test("readSSE handles CRLF streams and a space-less 'data:' value", async () => {
  const events = await collect(readSSE(streamOf(["data:a\r\n\r\ndata: b\r\n\r\n"])));
  assert.deepEqual(events.map((e) => e.data), ["a", "b"]);
});

test("readSSE works on an LLM-style token stream", async () => {
  const body = new Response('data: {"t":"Hel"}\n\ndata: {"t":"lo"}\n\ndata: [DONE]\n\n');
  const tokens = [];
  for await (const { data } of readSSE(body)) {
    if (data === "[DONE]") break;
    tokens.push(JSON.parse(data).t);
  }
  assert.equal(tokens.join(""), "Hello");
});

// ---- robustness: linear time, bounded memory, CR/LF edge cases ------------------

test("readLines: CRLF split exactly across chunks yields one line break, not two", async () => {
  assert.deepEqual(await collect(readLines(streamOf(["a\r", "\nb\r\n", "c"]))), ["a", "b", "c"]);
  assert.deepEqual(await collect(readLines(streamOf(["a\r", "b"]))), ["a", "b"]);
  assert.deepEqual(await collect(readLines(streamOf(["a\r\r\n\nb"]))), ["a", "", "", "b"]);
  assert.deepEqual(await collect(readLines(streamOf(["\n\n"]))), ["", ""]);
});

test("readLines: a line split over many chunks is reassembled", async () => {
  const parts = Array.from({ length: 200 }, (_, i) => `p${i}-`);
  const lines = await collect(readLines(streamOf([...parts, "\nnext\n"])));
  assert.deepEqual(lines, [parts.join(""), "next"]);
});

test("readLines: a server that never sends a newline hits maxLineLength instead of buffering forever", async () => {
  let sent = 0;
  const endless = new ReadableStream({
    pull(controller) {
      sent++;
      controller.enqueue(new Uint8Array(1024 * 1024).fill(97)); // 1 MiB of "a", forever
    },
  });
  const started = Date.now();
  await assert.rejects(collect(readLines(endless, { maxLineLength: 4 * 1024 * 1024 })), (e) => e.code === "LINE_TOO_LONG");
  assert.ok(sent <= 6, `stopped after ~${sent} MiB`);
  assert.ok(Date.now() - started < 2000, "and quickly");
});

test("readLines: linear time — 64 MB in 4 KB chunks with no newline finishes fast (the old scan was quadratic)", async () => {
  const chunk = new Uint8Array(4096).fill(98);
  let n = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (n++ >= 16 * 1024) return c.close();
      c.enqueue(chunk);
    },
  });
  const started = Date.now();
  const lines = await collect(readLines(stream, { maxLineLength: Infinity }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 64 * 1024 * 1024);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started}ms`);
});

test("readLines: very many short lines in one chunk are fast", async () => {
  const text = Array.from({ length: 200000 }, (_, i) => `l${i}`).join("\n");
  const started = Date.now();
  const lines = await collect(readLines(new Response(text)));
  assert.equal(lines.length, 200000);
  assert.ok(Date.now() - started < 3000);
});

test("readNDJSON and readSSE accept maxLineLength; readSSE also caps one event's data", async () => {
  await assert.rejects(collect(readNDJSON(streamOf(['{"a":"' + "x".repeat(100) + '"}\n']), { maxLineLength: 50 })), (e) => e.code === "LINE_TOO_LONG");
  await assert.rejects(collect(readSSE(streamOf(["data: " + "x".repeat(100) + "\n\n"]), { maxLineLength: 50 })), (e) => e.code === "LINE_TOO_LONG");
  // many small data lines that add up past the cap
  const many = Array.from({ length: 50 }, () => "data: 0123456789\n").join("") + "\n";
  await assert.rejects(collect(readSSE(streamOf([many]), { maxLineLength: 200 })), (e) => e.code === "LINE_TOO_LONG");
});
