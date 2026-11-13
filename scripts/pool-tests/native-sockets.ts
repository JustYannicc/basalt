import assert from "node:assert/strict";
import { Response as WorkerResponse, WebSocket, WebSocketPair } from "miniflare";

export function installWorkerSockets() {
  const response = Object.getOwnPropertyDescriptor(globalThis, "Response")!;
  const pair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    writable: true,
    value: WorkerResponse,
  });
  Object.defineProperty(globalThis, "WebSocketPair", {
    configurable: true,
    writable: true,
    value: WebSocketPair,
  });
  return () => {
    Object.defineProperty(globalThis, "Response", response);
    if (pair) Object.defineProperty(globalThis, "WebSocketPair", pair);
    else Reflect.deleteProperty(globalThis, "WebSocketPair");
  };
}

export function upgraded(response: Response) {
  const socket: unknown = Reflect.get(response, "webSocket");
  assert.ok(socket instanceof WebSocket);
  socket.accept();
  return socket;
}
