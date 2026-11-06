import assert from "node:assert/strict";
import { test } from "node:test";
import { TunnelWebSocket } from "./websocket.ts";
import { TunnelOutput } from "./flow.ts";
import { recordTunnelFailure, tunnelFailure, type TunnelFailure } from "./failure.ts";
import type { TunnelSocket } from "./platform.ts";

class Peer extends EventTarget implements TunnelSocket {
  binaryType: BinaryType = "arraybuffer";
  accept() {}
  send() {}
  close() {
    this.dispatchEvent(new Event("close"));
  }
}

test("socket error evidence keeps known exception identifiers without peer text", (context) => {
  const records: string[] = [];
  context.mock.method(console, "warn", (record: string) => records.push(record));
  const peer = new Peer();
  const socket = new TunnelWebSocket(
    peer,
    7,
    new TunnelOutput(),
    () => {},
    (failure) => recordTunnelFailure(7, failure),
    () => {},
  );
  const error = Object.assign(new TypeError("https://private.invalid/?token=never-retain"), {
    code: "ECONNRESET",
    url: "https://private.invalid",
    cause: new Error("private cause"),
  });
  peer.dispatchEvent(Object.assign(new Event("error"), { error }));
  assert.deepEqual(
    records.map((record) => JSON.parse(record.slice("NATIVE_TUNNEL_FAILURE ".length))),
    [
      {
        id: 7,
        class: "TypeError",
        name: "TypeError",
        code: "ECONNRESET",
        phase: "socket",
        event: "error",
      },
    ],
  );
  socket.stop();
  peer.dispatchEvent(Object.assign(new Event("error"), { error }));
  assert.equal(records.length, 1);
});

test("close-drain exceptions retain the close event and flush phase", async () => {
  const peer = new Peer(),
    output = new TunnelOutput();
  output.grant(65536);
  let finish!: (failure: TunnelFailure) => void;
  const captured = new Promise<TunnelFailure>((resolve) => {
    finish = resolve;
  });
  const socket = new TunnelWebSocket(
    peer,
    7,
    output,
    () => {
      throw new DOMException("https://private.invalid/never-retain", "InvalidStateError");
    },
    finish,
    () => {},
  );
  peer.dispatchEvent(new MessageEvent("message", { data: "retained-before-close" }));
  peer.close();
  assert.deepEqual(await captured, {
    class: "DOMException",
    name: "InvalidStateError",
    code: 11,
    phase: "flush",
    event: "close",
  });
  socket.stop();
});

test("unknown exception fields and throwing accessors cannot export arbitrary text", () => {
  const privateText = "https://private.invalid/?token=never-retain";
  assert.deepEqual(
    tunnelFailure(
      {
        constructor: { name: privateText },
        name: privateText,
        code: privateText,
        message: privateText,
      },
      "socket",
      "error",
    ),
    {
      class: "unknown",
      name: "unknown",
      code: "other",
      phase: "socket",
      event: "error",
    },
  );
  const error = Object.defineProperty({}, "name", {
    get() {
      throw new Error(privateText);
    },
  });
  assert.deepEqual(tunnelFailure(error, "socket", "error"), {
    class: "unknown",
    name: "unknown",
    code: null,
    phase: "socket",
    event: "error",
  });
});
