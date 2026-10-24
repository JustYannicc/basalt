import assert from "node:assert/strict";
import test from "node:test";
import { verifySse } from "./sse.ts";
import { AcceptanceFailure } from "./types.ts";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

test("SSE accepts split JSON text chunks and records first-byte and total time", async () => {
  let time = 100;
  const chunks = [
    'data: {"choices":[{"delta":{"content":"O',
    'K"}}]}\n\ndata: [DONE]\n\n',
  ];
  const result = await verifySse(
    streamResponse(chunks),
    70,
    { now: () => (time += 10) },
  );
  assert.deepEqual(result, { firstByteMs: 40, totalMs: 50 });
});

test("SSE rejects a stream that errors while the body is being read", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n'));
      controller.error(new Error("fixture stream reset"));
    },
  });
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(verifySse(response, 0), (error: unknown) => {
    assert.ok(error instanceof AcceptanceFailure);
    assert.equal(error.message, "Could not read the SSE response");
    return true;
  });
});

test("SSE rejects malformed event data and missing completion sentinels", async () => {
  await assert.rejects(
    verifySse(streamResponse(["data: {broken}\n\ndata: [DONE]\n\n"]), 0),
    /SSE response contained invalid event JSON/,
  );
  await assert.rejects(
    verifySse(streamResponse(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n']), 0),
    /SSE response lacked generated text or the \[DONE\] event/,
  );
});
