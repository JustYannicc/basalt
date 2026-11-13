import assert from "node:assert/strict";
import { test } from "node:test";
import { negotiatedTunnelSocket } from "../connection/tunnel-socket.ts";
import type { WireEvent } from "../contracts/transport.ts";

for (const statusless of [false, true])
  test(`tunnel fallback is bounded before dispatch, statusless=${statusless}`, () => {
    const protocols: string[] = [];
    const listeners: ((event: WireEvent) => void)[] = [];
    const writes: { protocol: string; value: string }[] = [];
    const events: WireEvent[] = [];
    const socket = negotiatedTunnelSocket((protocol) => {
      protocols.push(protocol);
      return {
        send: (value) => writes.push({ protocol, value }),
        close() {},
        listen: (receive) => {
          listeners.push(receive);
          return () => {};
        },
      };
    }, statusless);
    socket.listen((event) => events.push(event));
    listeners[0]!({ type: "error", ...(statusless ? {} : { status: 400 }) });
    assert.deepEqual(protocols, ["basalt.tunnel.v2", "basalt.tunnel.v1"]);
    assert.deepEqual(writes, [], "No operation may precede negotiation.");
    listeners[0]!({ type: "close" });
    assert.deepEqual(events, [], "The abandoned socket cannot affect fallback.");
    listeners[1]!({ type: "error", status: 400 });
    assert.equal(protocols.length, 2, "Never loop fallback.");
    assert.equal(events.length, 1);
    socket.close();
  });

test("READY seals v2 and a later disconnect never creates a replacement socket", () => {
  const protocols: string[] = [];
  let receive!: (event: WireEvent) => void;
  const events: WireEvent[] = [];
  const socket = negotiatedTunnelSocket((protocol) => {
    protocols.push(protocol);
    return {
      send() {},
      close() {},
      listen: (listener) => {
        receive = listener;
        return () => {};
      },
    };
  }, true);
  socket.listen((event) => events.push(event));
  // Even malformed first data forbids a fallback that might hide a partially started session.
  receive({ type: "message", data: "malformed" });
  receive({ type: "error" });
  assert.deepEqual(protocols, ["basalt.tunnel.v2"]);
  assert.equal(events[0]?.type, "error");
  socket.close();
});

test("authorization refusal and caller cancellation never fall back", () => {
  for (const cancelled of [false, true]) {
    const protocols: string[] = [];
    let receive!: (event: WireEvent) => void;
    const socket = negotiatedTunnelSocket((protocol) => {
      protocols.push(protocol);
      return {
        send() {},
        close() {},
        listen: (listener) => {
          receive = listener;
          return () => {};
        },
      };
    });
    const unlisten = socket.listen(() => {});
    if (cancelled) unlisten();
    receive({ type: "error", status: cancelled ? 400 : 401 });
    assert.deepEqual(protocols, ["basalt.tunnel.v2"]);
    socket.close();
  }
});
