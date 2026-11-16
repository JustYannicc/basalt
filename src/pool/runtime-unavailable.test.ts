import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeRuntimeStream } from "./runtime-unavailable.ts";

for (const [path, expected] of [
  ["messages", "overloaded_error"],
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
