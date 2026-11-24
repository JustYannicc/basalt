import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RuntimeModelLifetimes,
  type RuntimeControlSocket,
} from "./runtime-slots/model-lifetime.ts";
import { modelLifetimeHeader, modelLifetimeProtocol } from "./model-lifetime-contract.ts";
import type { SlotIdentity } from "./runtime-slots/contract.ts";

const identity: SlotIdentity = {
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: "runtime-1",
  applicationId: "blue",
  applicationVersion: "1",
  instanceId: "runtime-1",
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageInput: "image-1",
  bootId: "boot-1",
};

function socket() {
  const listeners = new Map<string, ((event: never) => void)[]>();
  const value = {
    closed: undefined as number | undefined,
    accept() {},
    send() {},
    close(code?: number) {
      value.closed ??= code ?? 1000;
    },
    addEventListener(type: string, listener: (event: never) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  return value as typeof value & RuntimeControlSocket;
}

test("a caller who leaves a model socket's lifetime ends it, closes both ends and releases once", () => {
  const upstream = socket();
  const server = socket();
  const lifetimes = new RuntimeModelLifetimes(() => ({
    server,
    response: new Response(null, { status: 200 }),
  }));
  const caller = new AbortController();
  const id = "a".repeat(32);
  const request = new Request("http://pool/v1/responses", {
    headers: { [modelLifetimeHeader]: id, Upgrade: "websocket" },
    signal: caller.signal,
  });
  const answer = {
    status: 101,
    webSocket: upstream,
    headers: new Headers({ "Sec-WebSocket-Protocol": modelLifetimeProtocol }),
    body: null,
  } as unknown as Response;
  let releases = 0;
  lifetimes.control(identity, request, answer, () => {
    releases++;
  });
  assert.equal(releases, 0, "a live lifetime holds its lease");
  caller.abort();
  assert.equal(releases, 1);
  assert.equal(upstream.closed, 1011);
  assert.equal(server.closed, 1011);
  caller.signal.dispatchEvent(new Event("abort"));
  assert.equal(releases, 1, "released once");
});
