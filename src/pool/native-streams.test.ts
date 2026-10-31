import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeStreams } from "./native-streams.ts";

test("a pool membership reservation aborts its HTTP and WebSocket leases while another pool continues", () => {
  const streams = new NativeStreams(), caller = new AbortController();
  const http = streams.acquire("computer-a", "a", caller.signal);
  const socket = streams.acquire("computer-b", "a", caller.signal);
  const other = streams.acquire("computer-c", "b", caller.signal);
  let closed = 0;
  socket.onClose(() => { closed += 1; });
  streams.abortPool("a");
  assert.equal(http.signal.aborted, true);
  assert.equal(socket.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  assert.equal(closed, 1);
  streams.abortPool("a");
  assert.equal(closed, 1);
  other.release();
});
