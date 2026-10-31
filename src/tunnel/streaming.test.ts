import assert from "node:assert/strict";
import { test } from "node:test";
import { TunnelWebSocket } from "./websocket.ts";
import { TunnelOutput } from "./flow.ts";
import { TunnelOperation } from "./operation.ts";
import type { TunnelSocket } from "./platform.ts";
import {
  decodeTunnelFrame,
  tunnelLimits,
  type TunnelServerFrame,
} from "../../clients/contracts/tunnel.ts";

class Peer extends EventTarget implements TunnelSocket {
  binaryType: BinaryType = "arraybuffer";
  sent: Parameters<WebSocket["send"]>[0][] = [];
  accept() {}
  send(data: Parameters<WebSocket["send"]>[0]) {
    this.sent.push(data);
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  message(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

test("provider close drains queued WebSocket output after withheld credit is granted", async () => {
  const peer = new Peer();
  const output = new TunnelOutput();
  const frames: TunnelServerFrame[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let ended = false;
  const socket = new TunnelWebSocket(
    peer,
    1,
    output,
    (frame) => frames.push(frame),
    () => assert.fail("Unexpected refusal"),
    () => {
      ended = true;
      finish();
    },
  );
  peer.message("queued-before-close");
  peer.close();
  assert.equal(ended, false, "Close must wait for queued data");
  assert.equal(frames.length, 0);
  output.grant(tunnelLimits.windowBytes);
  await finished;
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["data"],
  );
  const frame = frames[0];
  assert.equal(frame?.type, "data");
  if (frame?.type === "data")
    assert.equal(Buffer.from(frame.bytes, "base64").toString(), "queued-before-close");
  socket.stop();
});

test("HTTP response chunking is independent of a large upstream read", async () => {
  const expected = new Uint8Array(200000).fill(137);
  const frames: TunnelServerFrame[] = [];
  const operation = new TunnelOperation(
    {
      v: 1,
      type: "open",
      id: 1,
      operation: { service: "tools", method: "GET", path: "/mcp", transport: "http" },
      headers: {},
    },
    (frame) => {
      frames.push(frame);
      if (frame.type === "data") operation.output.grant(Buffer.from(frame.bytes, "base64").length);
    },
    () => {},
  );
  operation.output.grant(tunnelLimits.windowBytes);
  await operation.run(
    new Request("https://router.example/native/v1/tunnel", {
      headers: { authorization: "Bearer scoped-native" },
    }),
    {
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      TOOLS_SERVICE: { fetch: () => Promise.resolve(new Response(expected)) },
      POOL_SERVICE: { fetch: () => Promise.reject(new Error("Models are not involved")) },
    },
  );
  assert.equal(
    frames.some((frame) => frame.type === "error"),
    false,
  );
  const chunks = frames.flatMap((frame) =>
    frame.type === "data" ? [Buffer.from(frame.bytes, "base64")] : [],
  );
  assert.ok(chunks.every((chunk) => chunk.length <= tunnelLimits.chunkBytes));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(expected));
  assert.equal(frames.at(-1)?.type, "end");
});

test("empty text and binary WebSocket messages round trip without byte credit", async () => {
  const peer = new Peer();
  const frames: TunnelServerFrame[] = [];
  const socket = new TunnelWebSocket(
    peer,
    1,
    new TunnelOutput(),
    (frame) => frames.push(frame),
    () => assert.fail("Empty messages are valid"),
    () => {},
  );
  for (const text of [true, false]) {
    const value = decodeTunnelFrame(
      JSON.stringify({ v: 1, type: "data", id: 1, bytes: "", text }),
      "client",
    );
    assert.equal(value.type, "data");
    if (value.type === "data") socket.receive(new Uint8Array(), value.text, false);
  }
  assert.equal(peer.sent[0], "");
  assert.ok(peer.sent[1] instanceof ArrayBuffer && peer.sent[1].byteLength === 0);
  peer.message("");
  peer.message(new ArrayBuffer(0));
  await Promise.resolve();
  assert.deepEqual(
    frames.map((frame) =>
      frame.type === "data" ? { type: frame.type, bytes: frame.bytes, text: frame.text } : frame,
    ),
    [
      { type: "data", bytes: "", text: true },
      { type: "data", bytes: "", text: false },
    ],
  );
  assert.throws(() => socket.receive(new Uint8Array(), false, true), /empty|Empty/);
  socket.stop();
});
