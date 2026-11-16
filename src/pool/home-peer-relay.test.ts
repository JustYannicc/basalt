import assert from "node:assert/strict";
import test from "node:test";
import {
  homePeerChunk,
  homePeerWindow,
  relayHomePeer,
  type HomePeerSocket,
  type HomePeerWebSocket,
} from "./home-peer-relay.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class Peer implements HomePeerWebSocket {
  binaryType: "blob" | "arraybuffer" = "blob";
  other?: Peer;
  frames: (string | Uint8Array)[] = [];
  closed?: number;
  onBinary?: () => void;
  private messages: ((event: { data: unknown }) => void)[] = [];
  private closes: (() => void)[] = [];
  send(value: string | ArrayBuffer | ArrayBufferView) {
    const frame =
      typeof value === "string"
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value.slice(0))
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    this.frames.push(frame);
    if (typeof frame !== "string") this.onBinary?.();
    queueMicrotask(() => this.other?.emit(typeof frame === "string" ? frame : frame.buffer));
  }
  close(code: number) {
    if (this.closed !== undefined) return;
    this.closed = code;
    queueMicrotask(() => this.other?.closes.forEach((listener) => listener()));
  }
  addEventListener(type: string, listener: ((event: { data: unknown }) => void) | (() => void)) {
    if (type === "message") this.messages.push(listener);
    if (type === "close") this.closes.push(listener as () => void);
  }
  emit(data: unknown) {
    this.messages.forEach((listener) => listener({ data }));
  }
}

function idleSocket(): HomePeerSocket {
  return {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    close: async () => {},
  };
}

test("a slow destination receives no more than its credit window and later drains exactly", async () => {
  const left = new Peer(),
    right = new Peer();
  left.other = right;
  right.other = left;
  const full = deferred(),
    release = deferred(),
    delivered = deferred();
  const total = homePeerWindow * 16;
  let supplied = 0,
    received = 0;
  left.onBinary = () => {
    const sent = left.frames.reduce(
      (sum, frame) => sum + (typeof frame === "string" ? 0 : frame.length),
      0,
    );
    if (sent === homePeerWindow) full.resolve();
  };
  const input = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (supplied === total) return controller.close();
        controller.enqueue(new Uint8Array(homePeerChunk).fill((supplied / homePeerChunk) % 251));
        supplied += homePeerChunk;
      },
    },
    { highWaterMark: 0 },
  );
  const first = relayHomePeer({ ...idleSocket(), readable: input }, left, () => {});
  assert.equal(left.binaryType, "arraybuffer");
  const second = relayHomePeer(
    {
      ...idleSocket(),
      writable: new WritableStream<Uint8Array>({
        async write(chunk) {
          await release.promise;
          assert.equal(chunk.length, homePeerChunk);
          assert.equal(chunk[0], (received / homePeerChunk) % 251);
          assert.equal(chunk.at(-1), chunk[0]);
          received += chunk.length;
          if (received === total) delivered.resolve();
        },
      }),
    },
    right,
    () => {},
  );
  await full.promise;
  assert.equal(supplied, homePeerWindow);
  assert.equal(received, 0);
  assert.equal(
    right.frames.filter((frame) => typeof frame === "string" && frame.includes("credit")).length,
    1,
  );
  release.resolve();
  await delivered.promise;
  assert.equal(received, total);
  first.close();
  second.close();
  await Promise.all([first.done, second.done]);
  assert.ok(
    left.frames.every((frame) => typeof frame === "string" || frame.length <= homePeerChunk),
  );
});

test("a TCP half close still receives the peer's reply", async () => {
  const peer = new Peer();
  const fin = deferred();
  peer.send = (value) => {
    if (value === JSON.stringify({ fin: true })) fin.resolve();
  };
  const output: number[] = [];
  const relay = relayHomePeer(
    {
      ...idleSocket(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          output.push(...chunk);
        },
      }),
    },
    peer,
    () => {},
  );
  peer.emit(JSON.stringify({ credit: homePeerWindow }));
  await fin.promise;
  assert.equal(peer.closed, undefined);
  peer.emit(new Uint8Array([1, 2, 3]).buffer);
  peer.emit(JSON.stringify({ fin: true }));
  await relay.done;
  assert.deepEqual(output, [1, 2, 3]);
  assert.equal(peer.closed, 1000);
});

test("oversized messages, excess credit and bytes after EOF refuse without buffering", async () => {
  for (const frames of [
    [new ArrayBuffer(homePeerChunk + 1)],
    [JSON.stringify({ credit: homePeerWindow }), JSON.stringify({ credit: 1 })],
    [JSON.stringify({ fin: true }), new ArrayBuffer(1)],
    [JSON.stringify({ credit: 0 })],
    ["x".repeat(65)],
  ]) {
    const peer = new Peer();
    const relay = relayHomePeer(idleSocket(), peer, () => {});
    for (const frame of frames) peer.emit(frame);
    await relay.done;
    assert.equal(peer.closed, 1002);
  }
});
