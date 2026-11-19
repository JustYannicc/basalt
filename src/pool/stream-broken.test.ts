import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeStreams, type NativeStreamLease } from "./native-streams.ts";
import { reportStreamBroken } from "./stream-broken.ts";

// Keep Workers platform types in tsconfig.worker.json, like model-auth.worker.test.ts.
const nativeModule = "./native-response.worker.ts";
const {
  nativeResponse,
}: { nativeResponse(response: Response, lease: NativeStreamLease): Response } = await import(
  nativeModule
);

test("a replacement that breaks every stream at once writes at most three closed lines a second", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_500 });
  const log = context.mock.method(console, "error", () => {});
  const reset = () =>
    Object.assign(
      new Error(
        "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
      ),
      { retryable: true },
    );
  for (let index = 0; index < 5; index++) reportStreamBroken("native", reset());
  context.mock.timers.tick(1_000);
  reportStreamBroken("terminal", new Error("private-detail"));
  const lines = log.mock.calls.map((call) => call.arguments);
  assert.deepEqual(
    lines.map(([marker, fields]) => [marker, fields.where, fields.messageClass, fields.retryable]),
    [
      ["POOL_STREAM_BROKEN", "native", "instance_inactive", true],
      ["POOL_STREAM_BROKEN", "native", "instance_inactive", true],
      ["POOL_STREAM_BROKEN", "native", "instance_inactive", true],
      ["POOL_STREAM_BROKEN", "terminal", "other", null],
    ],
  );
  assert.doesNotMatch(JSON.stringify(lines), /no longer active|private-detail/);
});

function failing(error: Error) {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(error);
      },
    }),
  );
}

test("stacked wrappers write one line for one upstream failure, and none for a deliberate close", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const signal = new AbortController().signal;
  const inner = new NativeStreams(),
    outer = new NativeStreams();
  const broken = nativeResponse(
    nativeResponse(failing(new TypeError("private-upstream")), inner.acquire("c", "p", signal)),
    outer.acquire("c", "p", signal),
  );
  await assert.rejects(broken.text(), /private-upstream/);
  const held = new NativeStreams();
  const closed = nativeResponse(
    nativeResponse(new Response(new ReadableStream()), held.acquire("c", "p", signal)),
    outer.acquire("c", "p", signal),
  );
  const read = closed.text();
  held.abortPool("p");
  await assert.rejects(read, /Connection ended/);
  const lines = log.mock.calls.filter((call) => call.arguments[0] === "POOL_STREAM_BROKEN");
  assert.deepEqual(
    lines.map((call) => [call.arguments[1].where, call.arguments[1].name]),
    [["native", "TypeError"]],
  );
});
