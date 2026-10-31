import assert from "node:assert/strict";
import { test } from "node:test";
import { TunnelInput, TunnelOutput } from "./flow.ts";
import {
  decodeTunnelFrame,
  decodeTunnelResponseHeaders,
  tunnelLimits,
} from "../../clients/contracts/tunnel.ts";

test("a stopped downstream cannot accumulate or acknowledge more than its request window", async () => {
  const consumed: number[] = [];
  const input = new TunnelInput((bytes) => consumed.push(bytes));
  for (let i = 0; i < 4; i++) input.push(new Uint8Array(tunnelLimits.chunkBytes));
  assert.deepEqual(consumed, []);
  assert.throws(() => input.push(new Uint8Array(1)), /credit exceeded/);
  const reader = input.stream.getReader();
  assert.equal((await reader.read()).value?.length, tunnelLimits.chunkBytes);
  assert.deepEqual(consumed, [tunnelLimits.chunkBytes]);
  input.push(new Uint8Array(tunnelLimits.chunkBytes));
  input.end();
  assert.throws(() => input.push(new Uint8Array(1)));
  await reader.cancel();
});
test("response credit acknowledges actual sent bytes and cancellation wakes blocked reads", async () => {
  const output = new TunnelOutput();
  output.grant(tunnelLimits.windowBytes);
  assert.throws(() => output.grant(1), /Unbacked/);
  output.take(tunnelLimits.windowBytes);
  output.grant(1);
  assert.equal(await output.capacity(), 1);
  output.take(1);
  const waiting = output.capacity();
  output.abort();
  await assert.rejects(waiting, /interrupted/);
});
test("the wire boundary refuses destination substitution, credentials, oversized frames and unknown fields", () => {
  const frame = {
    v: 1,
    type: "open",
    id: 1,
    operation: { service: "models", method: "GET", path: "/v1/models", transport: "http" },
    headers: {},
  };
  assert.equal(decodeTunnelFrame(JSON.stringify(frame), "client").type, "open");
  for (const change of [
    { operation: { ...frame.operation, path: "https://other.example/v1/models" } },
    { operation: { ...frame.operation, path: "/v0/management/api-keys" } },
    { headers: { authorization: "Bearer other-person" } },
    { headers: { cookie: "browser=secret" } },
    { user: "other-person" },
  ])
    assert.throws(() => decodeTunnelFrame(JSON.stringify({ ...frame, ...change }), "client"));
  assert.throws(
    () => decodeTunnelFrame(" ".repeat(tunnelLimits.frameBytes + 1), "client"),
    /limit/,
  );
});

test("contract decoders retain ordinary response headers and refuse credentials", () => {
  assert.deepEqual(decodeTunnelResponseHeaders({ "content-type": "text/event-stream" }), {
    "content-type": "text/event-stream",
  });
  assert.throws(() => decodeTunnelResponseHeaders({ "set-cookie": "private" }));
  assert.throws(() => decodeTunnelResponseHeaders({ "content-type": "bad\r\nheader" }));
});
