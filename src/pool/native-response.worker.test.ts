import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeStreams } from "./native-streams.ts";

const responseModule = "./native-response.worker.ts";
const { nativeResponse }: { nativeResponse(response: Response, lease: ReturnType<NativeStreams["acquire"]>): Response } = await import(responseModule);

test("lease expiry errors an active HTTP response and cancels the upstream body without another request", async () => {
  const streams = new NativeStreams();
  const lease = streams.acquire("http", "pool", new AbortController().signal);
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
    cancel() { cancelled = true; },
  }));
  const reader = nativeResponse(upstream, lease).body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  const waiting = reader.read();
  streams.abortAll();
  await assert.rejects(waiting, /Connection ended/);
  assert.equal(cancelled, true);
  assert.equal(streams.active, 0);
});
