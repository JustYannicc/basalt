import assert from "node:assert/strict";
import { test } from "node:test";
import { reportStreamBroken } from "./stream-broken.ts";

test("a replacement that breaks every stream at once writes at most three closed lines a second", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_500 });
  const log = context.mock.method(console, "error", () => {});
  const reset = Object.assign(
    new Error(
      "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
    ),
    { retryable: true },
  );
  for (let index = 0; index < 5; index++) reportStreamBroken("native", reset);
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
