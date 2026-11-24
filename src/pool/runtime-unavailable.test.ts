import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeRuntimeStream } from "./runtime-unavailable.ts";

for (const [path, expected] of [
  ["messages", "api_error"],
  ["responses", "server_error"],
])
  test(`${path} interruption preserves completed frames, drops a partial event and ends in native retry advice`, async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const response = nativeRuntimeStream(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      new Request(`http://pool/v1/${path}`),
    );
    const reader = response.body!.getReader();
    const prefix = 'event: ping\ndata: {"type":"ping"}\n\n';
    source.enqueue(new TextEncoder().encode(prefix + 'event: broken\ndata: {"type":'));
    assert.equal(new TextDecoder().decode((await reader.read()).value), prefix);
    const terminal = reader.read();
    source.error(new Error("synthetic runtime crash"));
    const event = new TextDecoder().decode((await terminal).value);
    assert.match(event, new RegExp(expected!));
    assert.doesNotMatch(event, /broken|synthetic runtime crash/);
    assert.equal((await reader.read()).done, true);
  });

test("cancelled native streams propagate cancellation instead of inviting a retry", async () => {
  const abort = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = nativeRuntimeStream(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
    new Request("http://pool/v1/responses", { signal: abort.signal }),
  );
  const read = response.body!.getReader().read();
  abort.abort();
  source.error(new Error("cancelled"));
  await assert.rejects(read, /cancelled/);
});

test("a premature native EOF becomes a transient terminal and a completed stream stays complete", async () => {
  const request = new Request("http://pool/v1/responses");
  const wrap = (body: string) =>
    nativeRuntimeStream(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      request,
    );
  const incomplete = await wrap(
    'event: response.created\ndata: {"type":"response.created"}\n\n',
  ).text();
  assert.match(incomplete, /response.failed/);
  const completed = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  assert.equal(await wrap(completed).text(), completed);
});

test("large native events retain their payload and do not become overload errors", async () => {
  const body = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(1_100_000) })}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`;
  const response = nativeRuntimeStream(
    new Response(body, {
      headers: { "content-type": "text/event-stream", "content-length": String(body.length) },
    }),
    new Request("http://pool/v1/responses"),
  );
  assert.equal(response.headers.has("content-length"), false);
  assert.equal(await response.text(), body);
});

test("transport failure after a delivered native completion cannot introduce another terminal", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = nativeRuntimeStream(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
    new Request("http://pool/v1/responses"),
  );
  const reader = response.body!.getReader();
  source.enqueue(
    new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed"}\n\n'),
  );
  await reader.read();
  source.error(new Error("transport failed after completion"));
  assert.equal((await reader.read()).done, true);
});

const sse = { headers: { "content-type": "text/event-stream" } };
const filler = (size: number) => new TextEncoder().encode("x".repeat(size));

/** Over 4 MiB with no blank line, and a two-byte character split exactly where parsing stops. */
function endless() {
  const chunk = 64 * 1024;
  return [
    ...Array.from({ length: 64 }, () => filler(chunk)),
    new Uint8Array([...filler(chunk - 1), 0xc3]),
    new Uint8Array([0xa9, ...filler(chunk - 1)]),
    ...Array.from({ length: 14 }, () => filler(chunk)),
    new Uint8Array([0x61, 0xc3]),
    new Uint8Array([0xa9, 0x62]),
  ];
}

function source(
  parts: Uint8Array[],
  end: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[sent++];
      if (part) controller.enqueue(part);
      else end(controller);
    },
  });
}

test("an event that never ends is passed through byte for byte once it passes the parse bound", async () => {
  const parts = endless();
  const expected = Buffer.concat(parts);
  const interrupted: unknown[] = [];
  const response = nativeRuntimeStream(
    new Response(
      source(parts, (controller) => controller.close()),
      sse,
    ),
    new Request("http://pool/v1/messages"),
    (error) => interrupted.push(error),
  );
  const received = Buffer.from(await response.arrayBuffer());
  assert.equal(Buffer.compare(received, expected), 0);
  assert.deepEqual(interrupted, []);
});

test("past the parse bound an upstream failure cuts the stream, and a client leaving is quiet", async () => {
  const interrupted: unknown[] = [];
  const cut = nativeRuntimeStream(
    new Response(
      source(endless(), (controller) => controller.error(new Error("synthetic upstream cut"))),
      sse,
    ),
    new Request("http://pool/v1/messages"),
    (error) => interrupted.push(error),
  );
  await assert.rejects(cut.arrayBuffer(), /synthetic upstream cut/);
  assert.equal(interrupted.length, 1);
  const quiet: unknown[] = [];
  const left = nativeRuntimeStream(
    new Response(
      source(endless(), () => {}),
      sse,
    ),
    new Request("http://pool/v1/messages"),
    (error) => quiet.push(error),
  );
  const reader = left.body!.getReader();
  // One read returns the parsed part, the next ones come through the pass-through.
  for (let index = 0; index < 3; index++) await reader.read();
  await reader.cancel("client left");
  assert.deepEqual(quiet, []);
});

test("the native stream passes its answer's own bytes on: invalid UTF-8 and a leading BOM unchanged", async () => {
  const encoder = new TextEncoder();
  const parts = [
    new Uint8Array([0xef, 0xbb, 0xbf]),
    encoder.encode('event: content_block_delta\ndata: {"delta":{"text":"x'),
    new Uint8Array([0xff]),
    encoder.encode('"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'),
  ];
  const sent = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    sent.set(part, offset);
    offset += part.byteLength;
  }
  const answer = nativeRuntimeStream(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // Split inside the invalid byte's neighbours, as reads arrive.
          for (let index = 0; index < sent.byteLength; index += 5)
            controller.enqueue(sent.slice(index, index + 5));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
    new Request("https://pool.example/v1/messages", { method: "POST", body: "{}" }),
  );
  assert.deepEqual(new Uint8Array(await answer.arrayBuffer()), sent);
});
