import assert from "node:assert/strict";
import { test } from "node:test";
import { TunnelWebSocket } from "./websocket.ts";
import { TunnelOutput } from "./flow.ts";
import { tunnelLimits, type TunnelServerFrame } from "../../clients/contracts/tunnel.ts";
import type { TunnelSocket } from "./platform.ts";

const envelope = { ...tunnelLimits, websocketMessageBytes: 16 * 1024 * 1024 };
class Peer extends EventTarget implements TunnelSocket {
  binaryType: BinaryType = "arraybuffer";
  sent: Parameters<WebSocket["send"]>[0][] = [];
  framing: boolean;
  constructor(framing = false) {
    super();
    this.framing = framing;
  }
  accept() {}
  send(data: Parameters<WebSocket["send"]>[0]) {
    if (!this.framing) {
      this.sent.push(data);
      return;
    }
    assert.ok(data instanceof ArrayBuffer);
    const frame = new Uint8Array(data);
    const sequence = new DataView(data).getUint32(1);
    const body = frame.subarray(5);
    this.sent.push(frame[0] === 0 ? new TextDecoder().decode(body) : body.slice().buffer);
    queueMicrotask(() => {
      const receipt = new Uint8Array(9);
      receipt[0] = 2;
      const view = new DataView(receipt.buffer);
      view.setUint32(1, sequence);
      view.setUint32(5, body.length);
      this.dispatchEvent(new MessageEvent("message", { data: receipt.buffer }));
    });
  }
  message(data: string | ArrayBuffer) {
    if (!this.framing) {
      this.dispatchEvent(new MessageEvent("message", { data }));
      return;
    }
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const frame = new Uint8Array(1 + bytes.length);
    frame[0] = typeof data === "string" ? 0 : 1;
    frame.set(bytes, 1);
    this.dispatchEvent(new MessageEvent("message", { data: frame.buffer }));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
}

test("a non-reading consumer cannot earn credit by accepting repeated socket sends", () => {
  const peer = new Peer();
  const frames: TunnelServerFrame[] = [];
  const socket = new TunnelWebSocket(
    peer,
    1,
    new TunnelOutput(),
    (frame) => frames.push(frame),
    () => {},
    () => {},
    envelope,
  );
  try {
    for (let index = 0; index < 4; index++) socket.receive(new Uint8Array(16_384), false, false);
    assert.equal(
      frames.filter((frame) => frame.type === "credit").length,
      0,
      "WebSocket.send only queues bytes; only the consumer drain receipt can release credit.",
    );
    assert.throws(() => socket.receive(new Uint8Array(1), false, false), /credit/i);
  } finally {
    socket.stop();
  }
});

for (const size of [65_535, 65_536, 65_537, 16 * 1024 * 1024])
  test(`native WebSocket accepts a ${size}-byte message with bounded chunk credits`, async () => {
    const peer = new Peer(true);
    const frames: TunnelServerFrame[] = [];
    const socket = new TunnelWebSocket(
      peer,
      1,
      new TunnelOutput(),
      (frame) => frames.push(frame),
      () => assert.fail("Unexpected transport failure"),
      () => {},
      envelope,
    );
    try {
      const bytes = new Uint8Array(size).fill(97);
      for (let offset = 0; offset < size; offset += 16_384) {
        const part = bytes.subarray(offset, Math.min(size, offset + 16_384));
        socket.receive(part, true, offset + part.length < size);
      }
      await Promise.resolve();
      assert.deepEqual(peer.sent, ["a".repeat(size)]);
      assert.equal(
        frames.reduce((sum, frame) => sum + (frame.type === "credit" ? frame.bytes : 0), 0),
        size,
      );
    } finally {
      socket.stop();
    }
  });

test("native WebSocket accepts more than one MiB of turns without a lifetime byte cap", async () => {
  const peer = new Peer(true);
  const socket = new TunnelWebSocket(
    peer,
    1,
    new TunnelOutput(),
    () => {},
    () => assert.fail("Unexpected transport failure"),
    () => {},
    envelope,
  );
  try {
    for (let index = 0; index < 65; index++) {
      socket.receive(new Uint8Array(16_384), false, false);
      await Promise.resolve();
    }
    assert.equal(peer.sent.length, 65);
  } finally {
    socket.stop();
  }
});

test("large provider output waits for credit and preserves its message boundary after close", async () => {
  const peer = new Peer(true);
  const output = new TunnelOutput();
  const frames: TunnelServerFrame[] = [];
  const failures: unknown[] = [];
  const finished = Promise.withResolvers<void>();
  const expected = "🙂".repeat(50_000);
  const socket = new TunnelWebSocket(
    peer,
    1,
    output,
    (frame) => {
      frames.push(frame);
      if (frame.type === "data") output.grant(Buffer.from(frame.bytes, "base64").length);
    },
    (failure) => failures.push(failure),
    finished.resolve,
    envelope,
  );
  try {
    peer.message(expected);
    peer.close();
    assert.deepEqual(failures, []);
    assert.equal(frames.length, 0, "A slow reader withholds all credit.");
    output.grant(tunnelLimits.windowBytes);
    await finished.promise;
    const data = frames.filter((frame) => frame.type === "data");
    assert.ok(data.every((frame) => Buffer.from(frame.bytes, "base64").length <= 16_384));
    assert.deepEqual(
      data.map((frame) => frame.more),
      data.map((_, i) => i < data.length - 1),
    );
    assert.equal(
      Buffer.concat(data.map((frame) => Buffer.from(frame.bytes, "base64"))).toString(),
      expected,
    );
  } finally {
    socket.stop();
  }
});

test("oversized messages and a slow-reader queue overflow fail within the negotiated budget", () => {
  const peer = new Peer(true);
  const failures: unknown[] = [];
  const socket = new TunnelWebSocket(
    peer,
    1,
    new TunnelOutput(),
    () => {},
    (failure) => failures.push(failure),
    () => {},
    envelope,
  );
  try {
    const maximum = new Uint8Array(envelope.websocketMessageBytes);
    for (let offset = 0; offset < maximum.length; offset += 16_384)
      socket.receive(maximum.subarray(offset, offset + 16_384), false, true);
    assert.throws(() => socket.receive(new Uint8Array(1), false, false), /limit exceeded/);
    assert.equal(peer.sent.length, 0, "Oversized input must never reach the model.");
    peer.message(maximum.buffer);
    assert.deepEqual(failures, [], "One complete message may wait for a slow reader.");
    peer.message("x");
    assert.equal(failures.length, 1, "A second byte cannot exceed the retained output budget.");
  } finally {
    socket.stop();
  }
});

test("v1 keeps its original message, credit and cumulative input contract", () => {
  const peer = new Peer();
  const frames: TunnelServerFrame[] = [];
  const socket = new TunnelWebSocket(
    peer,
    1,
    new TunnelOutput(),
    (frame) => frames.push(frame),
    () => {},
    () => {},
  );
  try {
    socket.receive(new Uint8Array(16_384), false, true);
    assert.equal(frames.length, 0, "Legacy reassembly does not return early credit.");
    socket.receive(new Uint8Array(16_384), false, false);
    assert.deepEqual(frames, [{ v: 1, type: "credit", id: 1, bytes: 32_768 }]);
    for (let index = 0; index < 62; index++) socket.receive(new Uint8Array(16_384), false, false);
    assert.throws(() => socket.receive(new Uint8Array(1), false, false), /limit exceeded/);
  } finally {
    socket.stop();
  }
});
