// A device approved for tools only holds nothing at the pool, so its tunnel takes no pool lease:
// it opens and calls tools while the pool service fails. The tools gateway still checks the
// device's bearer when the tunnel opens and on every tool call it forwards.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTunnelFrame, tunnelLimits } from "../../clients/contracts/tunnel.ts";
import { failureResponse } from "../pool/json.ts";
import { tunnelAccess, tunnelLease, type TunnelEnvironment } from "./access.ts";
import type { TunnelSocket } from "./platform.ts";
import { serveTunnel } from "./session.ts";

class Peer extends EventTarget implements TunnelSocket {
  binaryType: BinaryType = "arraybuffer";
  sent: string[] = [];
  closed: number[] = [];
  accept() {}
  send(data: Parameters<WebSocket["send"]>[0]) {
    assert.equal(typeof data, "string");
    this.sent.push(String(data));
  }
  close(code = 1000) {
    this.closed.push(code);
    this.dispatchEvent(new Event("close"));
  }
  frame(value: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ v: 1, ...value }) }));
  }
}

const toolsOnly = {
  id: "native:tools-only",
  userId: "synthetic-person",
  clientId: "synthetic-client",
  expiresAt: Date.now() + 3_600_000,
  policy: {
    kind: "native" as const,
    computer: "synthetic-computer",
    pool: "synthetic-pool",
    models: false,
    toolsOrganization: "synthetic-team",
  },
};
const toolList = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "synthetic_tool" }] } };

test("a tools-only tunnel opens and calls a tool while the pool service fails", async () => {
  let poolCalls = 0;
  const gateway: { path: string; method: string }[] = [];
  const env: TunnelEnvironment = {
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    TOOLS_SERVICE: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        const call = { path, method: request.method };
        gateway.push(call);
        return path === "/api/auth/native/access"
          ? Response.json(toolsOnly)
          : Response.json(toolList);
      },
    },
    // What the pool Worker answers while its controller is down.
    POOL_SERVICE: {
      fetch: async () => {
        poolCalls++;
        return failureResponse(new Error("synthetic controller outage"));
      },
    },
  };
  const request = new Request("https://router.example/native/v1/tunnel", {
    headers: { upgrade: "websocket", authorization: "Bearer synthetic-native" },
  });
  const admitted = await tunnelAccess(request, env);
  assert.ok(!(admitted instanceof Response), "the tools gateway admits the device");
  let lease: Awaited<ReturnType<typeof tunnelLease>> | undefined;
  await assert.doesNotReject(async () => {
    lease = await tunnelLease(request, env, admitted);
  }, "a tools-only tunnel needs no pool lease");
  assert.equal(lease, undefined);
  assert.equal(poolCalls, 0, "the pool is not asked");

  const socket = new Peer();
  const work: Promise<unknown>[] = [];
  serveTunnel(socket, lease, request, env, admitted, (pending) => work.push(pending));
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  socket.frame({
    type: "open",
    id: 1,
    operation: { service: "tools", method: "POST", path: "/mcp", transport: "http" },
    headers: { "content-type": "application/json" },
  });
  socket.frame({ type: "credit", id: 1, bytes: tunnelLimits.windowBytes });
  socket.frame({ type: "data", id: 1, bytes: Buffer.from(body).toString("base64"), text: false });
  socket.frame({ type: "end", id: 1 });
  await work[1];

  const frames = socket.sent.map((frame) => decodeTunnelFrame(frame, "server"));
  assert.equal(frames[0]?.type, "ready");
  const response = frames.find((frame) => frame.type === "response");
  assert.ok(response?.type === "response");
  assert.equal(response.status, 200);
  const data = frames.flatMap((frame) =>
    frame.type === "data" ? [Buffer.from(frame.bytes, "base64")] : [],
  );
  assert.deepEqual(JSON.parse(Buffer.concat(data).toString()), toolList);
  assert.equal(frames.at(-1)?.type, "end");
  assert.deepEqual(gateway, [
    { path: "/api/auth/native/access", method: "GET" },
    { path: "/mcp", method: "POST" },
  ]);
  assert.equal(poolCalls, 0);
  assert.deepEqual(socket.closed, [], "the session stays open for the next call");
  socket.close();
});
