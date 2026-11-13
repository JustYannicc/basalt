import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelDrain } from "./model-drain.ts";
import type { TunnelSocket } from "./platform.ts";

const receipt = (sequence: number, bytes: number) => {
  const frame = new Uint8Array(9);
  frame[0] = 2;
  const view = new DataView(frame.buffer);
  view.setUint32(1, sequence);
  view.setUint32(5, bytes);
  return frame.buffer;
};

test("model read receipts require the exact pending sequence and byte count", () => {
  const sent: Parameters<TunnelSocket["send"]>[0][] = [];
  const peer: TunnelSocket = {
    binaryType: "arraybuffer",
    accept() {},
    close() {},
    addEventListener() {},
    send: (frame) => {
      sent.push(frame);
    },
  };
  const drain = new ModelDrain(peer, 16 * 1024 * 1024);
  drain.send(new Uint8Array([97, 98, 99]), true);
  assert.equal(drain.idle, false);
  assert.throws(() => drain.receive(receipt(2, 3)), /Unbacked/);
  assert.throws(() => drain.receive(receipt(1, 2)), /Unbacked/);
  assert.throws(() => drain.receive("provider-output-is-not-an-ack"), /Invalid/);
  assert.equal(drain.idle, false);
  assert.equal(drain.receive(receipt(1, 3)), undefined);
  assert.equal(drain.idle, true);
  assert.throws(() => drain.receive(receipt(1, 3)), /Unbacked/);
  assert.equal(sent.length, 1);
});

test("model input has both an aggregate byte bound and an empty-message count bound", () => {
  const peer: TunnelSocket = {
    binaryType: "arraybuffer",
    accept() {},
    close() {},
    addEventListener() {},
    send() {},
  };
  const drain = new ModelDrain(peer, 16 * 1024 * 1024);
  drain.send(new Uint8Array(16 * 1024 * 1024), false);
  drain.send(new Uint8Array(65_536), false);
  assert.throws(() => drain.send(new Uint8Array(1), false), /queue exceeded/);
  drain.stop();
  for (let i = 0; i < 256; i++) drain.send(new Uint8Array(), true);
  assert.throws(() => drain.send(new Uint8Array(), true), /queue exceeded/);
});
