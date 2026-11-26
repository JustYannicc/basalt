// MCP 2026-07-28 routes stateless requests by `mcp-*` headers, and a device's tunnel has to carry
// them to the tools service. Decoders accept them first; clients start sending them later.
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import {
  decodeTunnelFrame,
  maximumMcpHeaders,
  maximumUserAgentLength,
  tunnelLimits,
  tunnelResponseHeaderNames,
} from "../../clients/contracts/tunnel.ts";
import type { TunnelEnvironment } from "./access.ts";
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

const toolsOperation = { service: "tools", method: "POST", path: "/mcp", transport: "http" };
const openFrame = (headers: Record<string, string>) =>
  JSON.stringify({ v: 1, type: "open", id: 1, operation: toolsOperation, headers });
const decodesOpen = (headers: Record<string, string>) => {
  const frame = decodeTunnelFrame(openFrame(headers), "client");
  assert.ok(frame.type === "open");
  return frame.headers;
};
const refusesOpen = (headers: Record<string, string>) =>
  assert.throws(() => decodeTunnelFrame(openFrame(headers), "client"));
const mcpHeaders = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count - 2 }, (_, index) => [`mcp-param-p${index}`, "value"]).concat([
      ["mcp-session-id", "synthetic-session"],
      ["mcp-protocol-version", "2026-07-28"],
    ]),
  );

test("a request frame carries MCP routing headers", () => {
  const headers = {
    "content-type": "application/json",
    "mcp-method": "tools/call",
    "mcp-name": "synthetic_tool",
    "mcp-param-region": "eu",
  };
  assert.deepEqual(decodesOpen(headers), headers);
});

test("a model call's frame keeps the fixed headers it always had", () => {
  const model = (headers: Record<string, string>) =>
    JSON.stringify({
      v: 1,
      type: "open",
      id: 1,
      operation: { service: "models", method: "POST", path: "/v1/messages", transport: "http" },
      headers,
    });
  const fixed = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "mcp-session-id": "synthetic-session",
  };
  const frame = decodeTunnelFrame(model(fixed), "client");
  assert.ok(frame.type === "open");
  assert.deepEqual(frame.headers, fixed);
  const extras: ReadonlyArray<Record<string, string>> = [
    { "user-agent": "synthetic-client/1.0" },
    { "mcp-method": "tools/list" },
  ];
  for (const extra of extras)
    assert.throws(() => decodeTunnelFrame(model({ ...fixed, ...extra }), "client"));
});

test("every other unknown request header still refuses the frame", () => {
  refusesOpen({ "x-forwarded-host": "elsewhere.example" });
  refusesOpen({ authorization: "Bearer from-the-frame" });
  refusesOpen({ "accept-encoding": "gzip" });
  // Names arrive lowercase from Node and fetch; another spelling is an unknown key.
  refusesOpen({ "Mcp-Method": "tools/list" });
  refusesOpen({ "mcp-": "empty name" });
  refusesOpen({ "mcp-bad name": "space" });
});

test(`a request frame carries at most ${maximumMcpHeaders} MCP headers, fixed ones counted`, () => {
  assert.equal(Object.keys(decodesOpen(mcpHeaders(32))).length, 32);
  refusesOpen(mcpHeaders(33));
});

test("MCP header values keep the length and control-character checks", () => {
  assert.equal(decodesOpen({ "mcp-name": "a".repeat(4096) })["mcp-name"]?.length, 4096);
  refusesOpen({ "mcp-name": "a".repeat(4097) });
  for (const control of ["\r", "\n", "\0"]) {
    refusesOpen({ "mcp-name": `synthetic${control}tool` });
    refusesOpen({ "mcp-session-id": `synthetic${control}session` });
  }
});

test(`user-agent rides a request frame up to ${maximumUserAgentLength} characters`, () => {
  const agent = "synthetic-client/1.0 (".padEnd(maximumUserAgentLength - 1, "x") + ")";
  assert.equal(decodesOpen({ "user-agent": agent })["user-agent"], agent);
  refusesOpen({ "user-agent": `${agent}x` });
  refusesOpen({ "user-agent": "synthetic\r\nclient" });
});

test("an installed client's frame decodes exactly as before", () => {
  const sent = openFrame({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "content-encoding": "identity",
    "mcp-session-id": "synthetic-session",
    "mcp-protocol-version": "2025-11-25",
    "last-event-id": "7",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "synthetic",
    "openai-beta": "synthetic",
  });
  assert.equal(JSON.stringify(decodeTunnelFrame(sent, "client")), sent);
});

test("a response frame admits MCP headers while the server emits only the fixed set", async () => {
  const response = decodeTunnelFrame(
    JSON.stringify({
      v: 1,
      type: "response",
      id: 1,
      status: 200,
      headers: { "content-type": "application/json", "mcp-method": "tools/list" },
    }),
    "server",
  );
  assert.ok(response.type === "response");
  assert.equal(response.headers["mcp-method"], "tools/list");
  assert.throws(() =>
    decodeTunnelFrame(
      JSON.stringify({ v: 1, type: "response", id: 1, status: 200, headers: { "x-other": "1" } }),
      "server",
    ),
  );

  // Installed clients refuse unknown response keys, so emission must not widen with the schema.
  const emitted = [
    "content-type",
    "content-encoding",
    "content-length",
    "cache-control",
    "mcp-session-id",
    "mcp-protocol-version",
    "retry-after",
    "x-should-retry",
    "x-request-id",
    "request-id",
  ];
  assert.deepEqual(tunnelResponseHeaderNames, emitted);
  const upstream = Object.fromEntries(
    [...emitted, "mcp-method", "mcp-name", "mcp-param-region", "x-other"].map((name) => [
      name,
      "1",
    ]),
  );
  const { frames } = await toolsCall(async () => new Response("{}", { headers: upstream }), {});
  const head = frames.find((frame) => frame.type === "response");
  assert.ok(head?.type === "response");
  assert.deepEqual(Object.keys(head.headers).toSorted(), emitted.toSorted());
});

const toolsAccess = {
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

/** One tools POST through the server's real tunnel session, answered by `tools`. */
async function toolsCall(
  tools: (request: Request) => Promise<Response>,
  headers: Record<string, string>,
  body = "{}",
) {
  const env: TunnelEnvironment = {
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    TOOLS_SERVICE: { fetch: tools },
    POOL_SERVICE: { fetch: async () => new Response(null, { status: 503 }) },
  };
  const request = new Request("https://router.example/native/v1/tunnel", {
    headers: { upgrade: "websocket", authorization: "Bearer synthetic-native" },
  });
  const socket = new Peer();
  const work: Promise<unknown>[] = [];
  serveTunnel(socket, undefined, request, env, toolsAccess, (pending) => work.push(pending));
  socket.frame({ type: "open", id: 1, operation: toolsOperation, headers });
  socket.frame({ type: "credit", id: 1, bytes: tunnelLimits.windowBytes });
  socket.frame({ type: "data", id: 1, bytes: Buffer.from(body).toString("base64"), text: false });
  socket.frame({ type: "end", id: 1 });
  await work[1];
  assert.deepEqual(socket.closed, [], "the frame is accepted and the session stays open");
  const frames = socket.sent.map((frame) => decodeTunnelFrame(frame, "server"));
  socket.close();
  return { frames };
}

test("a 2026-07-28 tools/list through a device tunnel passes effect's stateless MCP check", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    McpServer.layerHttp({
      name: "synthetic-tools",
      version: "1.0.0",
      path: "/mcp",
      protocols: [McpProtocol.v2026_07_28],
    }),
    { disableLogger: true },
  );
  const seen: Headers[] = [];
  const tools = async (request: Request) => {
    seen.push(new Headers(request.headers));
    return handler(request);
  };
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "user-agent": "synthetic-mcp-client/1.0",
  };
  const list = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  const status = (frames: { type: string; status?: number }[]) =>
    frames.find((frame) => frame.type === "response")?.status;
  try {
    // The service really applies the stateless check: without the header it refuses the call.
    assert.equal(status((await toolsCall(tools, headers, list)).frames), 400);
    seen.length = 0;
    const { frames } = await toolsCall(tools, { ...headers, "mcp-method": "tools/list" }, list);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.get("mcp-method"), "tools/list");
    assert.equal(seen[0]?.get("user-agent"), "synthetic-mcp-client/1.0");
    assert.equal(seen[0]?.get("authorization"), "Bearer synthetic-native");
    assert.equal(seen[0]?.get("accept-encoding"), "identity");
    const head = frames.find((frame) => frame.type === "response");
    assert.ok(head?.type === "response");
    const body = frames.flatMap((frame) =>
      frame.type === "data" ? [Buffer.from(frame.bytes, "base64")] : [],
    );
    assert.equal(head.status, 200, Buffer.concat(body).toString());
    assert.deepEqual(JSON.parse(Buffer.concat(body).toString()).result.tools, []);
    assert.equal(frames.at(-1)?.type, "end");
  } finally {
    await dispose();
  }
});
