// MCP 2026-07-28 routes stateless requests by `mcp-*` headers. A local client's call has to reach
// the tools service with them, behind a device tunnel and on the direct forward alike.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer, type RawData } from "ws";
import { startGateway } from "../cli/gateway.ts";
import { deviceSocket } from "../cli/device-socket.ts";
import { tokenHash } from "../cli/local-access.ts";
import { openTunnel } from "../connection/tunnel.ts";
import type { ConnectionTransport, CredentialSource } from "../contracts/connection.ts";
import type { OpenOperation } from "../contracts/transport.ts";
import { LocalRequestRefused } from "../contracts/model-error.ts";
import { forwardedRequestHeaders } from "../contracts/tunnel-headers.ts";
import {
  decodeTunnelFrame,
  maximumMcpHeaders,
  maximumUserAgentLength,
  tunnelProtocol,
} from "../contracts/tunnel.ts";
import type { TunnelAccess, TunnelEnvironment } from "../../src/tunnel/access.ts";
import type { TunnelSocket } from "../../src/tunnel/platform.ts";

// Keep server app types out of the independently installed client test project.
const sessionModule = "../../src/tunnel/session.ts";
const {
  serveTunnel,
}: {
  serveTunnel(
    socket: TunnelSocket,
    lease: TunnelSocket | undefined,
    request: Request,
    env: TunnelEnvironment,
    access: TunnelAccess,
    keepAlive: (work: Promise<unknown>) => void,
  ): void;
} = await import(sessionModule);

const fixed = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "content-encoding": "identity",
  "mcp-session-id": "synthetic-session",
  "mcp-protocol-version": "2025-11-25",
  "last-event-id": "7",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "synthetic",
  "openai-beta": "synthetic",
};
const routing = {
  "mcp-method": "tools/call",
  "mcp-name": "synthetic_tool",
  "mcp-param-x": "eu",
  "user-agent": "synthetic-mcp-client/1.0",
};
const frame = (service: "models" | "tools", headers: Record<string, string>) =>
  JSON.stringify({
    v: 1,
    type: "open",
    id: 1,
    operation:
      service === "tools"
        ? { service, method: "POST", path: "/mcp", transport: "http" }
        : { service, method: "POST", path: "/v1/messages", transport: "http" },
    headers,
  });

test("a tools call keeps its MCP routing headers and user agent, and nothing else", () => {
  const headers = forwardedRequestHeaders(
    { ...fixed, ...routing, authorization: "Bearer local", cookie: "a=b", "x-other": "1" },
    "tools",
  );
  assert.deepEqual(headers, { ...fixed, ...routing });
  const open = decodeTunnelFrame(frame("tools", headers), "client");
  assert.ok(open.type === "open");
  assert.deepEqual(open.headers, headers);
});

test("a tools call without routing headers carries only names an older server accepts", () => {
  const headers = forwardedRequestHeaders(
    { ...fixed, "user-agent": "synthetic-mcp-client/1.0", "mcp-session-id": "s" },
    "tools",
  );
  assert.deepEqual(headers, { ...fixed, "mcp-session-id": "s" });
  const older = [
    "accept",
    "content-type",
    "content-encoding",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
    "anthropic-version",
    "anthropic-beta",
    "openai-beta",
  ];
  assert.deepEqual(
    Object.keys(headers).filter((name) => !older.includes(name)),
    [],
  );
});

test("a model call keeps exactly the fixed set, and its frame is unchanged", () => {
  const headers = forwardedRequestHeaders({ ...fixed, ...routing, "x-api-key": "k" }, "models");
  assert.deepEqual(headers, fixed);
  const sent = frame("models", headers);
  assert.equal(JSON.stringify(decodeTunnelFrame(sent, "client")), sent);
});

test("a tools call whose MCP headers break a cap is refused, never trimmed", () => {
  const many = Object.fromEntries(
    Array.from({ length: maximumMcpHeaders - 1 }, (_, index) => [`mcp-param-p${index}`, "v"]),
  );
  const atLimit = forwardedRequestHeaders({ ...many, "mcp-session-id": "s" }, "tools");
  assert.equal(Object.keys(atLimit).length, maximumMcpHeaders);
  for (const incoming of [
    { ...many, "mcp-session-id": "s", "mcp-protocol-version": "2026-07-28" },
    { "mcp-name": "a".repeat(4097) },
    { "mcp-": "empty name" },
  ])
    assert.throws(() => forwardedRequestHeaders(incoming, "tools"), LocalRequestRefused);
  assert.throws(
    () => forwardedRequestHeaders({ "mcp-": "empty name" }, "tools"),
    /header name the connection cannot carry/u,
  );
});

test("an oversized user agent is dropped, and the call still goes", () => {
  const agent = "a".repeat(maximumUserAgentLength + 1);
  assert.deepEqual(
    forwardedRequestHeaders({ "mcp-method": "tools/list", "user-agent": agent }, "tools"),
    { "mcp-method": "tools/list" },
  );
});

const token = "synthetic_local_token_01234567890123456789";
async function gateway(transport: () => ConnectionTransport) {
  const home = await mkdtemp(join(tmpdir(), "mcp-headers-"));
  const source: CredentialSource = {
    view: () => ({ mode: "device", state: "connected", capabilities: ["models", "tools"] }),
    apps: async () => undefined,
    origins: () => [],
    transport: async () => transport(),
    disconnect: async () => {},
    reconnect: async () => {},
    signOut: async () => {},
    revoke: async () => {},
  };
  const running = await startGateway({
    source,
    port: 0,
    operatorHash: tokenHash(token),
    ipcPath: join(home, "gateway.sock"),
    profile: async () => ({
      version: 1,
      storage: "os",
      port: 0,
      agents: [
        {
          id: "synthetic",
          name: "Synthetic",
          tokenHash: tokenHash(token),
          capabilities: ["models", "tools"],
        },
      ],
    }),
  });
  return {
    post: (path: string, headers: Record<string, string>, body: string) =>
      fetch(`${running.origin}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...headers },
        body,
      }),
    close: async () => {
      await running.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
const listing = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": "tools/list",
  "user-agent": "synthetic-mcp-client/1.0",
};
const listBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const bytes = (data: RawData) =>
  Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;

/** The server's real tunnel session, with the tools service and the pool recorded. */
async function tunnelServer() {
  const tools: Headers[] = [];
  const opens: OpenOperation[] = [];
  const access = {
    id: "native:synthetic",
    userId: "synthetic-person",
    clientId: "synthetic-client",
    expiresAt: Date.now() + 3_600_000,
    policy: {
      kind: "native",
      computer: "synthetic-computer",
      pool: "synthetic-pool",
      models: true,
      toolsOrganization: "synthetic-team",
    },
  } as const;
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer();
  server.on("upgrade", (request, connection, head) => {
    // HTTP operations ride either protocol; v1 keeps the session's default limits.
    if (request.headers["sec-websocket-protocol"] !== tunnelProtocol) {
      connection.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, connection, head, (peer) => {
      const events = new EventTarget();
      peer.on("message", (data, binary) => {
        const value = bytes(data);
        events.dispatchEvent(
          new MessageEvent("message", {
            data: binary
              ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
              : value.toString(),
          }),
        );
      });
      peer.on("close", () => events.dispatchEvent(new Event("close")));
      serveTunnel(
        {
          binaryType: "arraybuffer",
          accept() {},
          send: (data) => peer.send(data),
          close: () => peer.close(),
          addEventListener: events.addEventListener.bind(events),
        },
        undefined,
        new Request("https://synthetic.invalid/native/v1/tunnel", {
          headers: { authorization: "Bearer synthetic-native" },
        }),
        {
          POOL_APP_SIGNING_KEY: "ab".repeat(32),
          TOOLS_SERVICE: {
            fetch: async (call: Request) => {
              tools.push(new Headers(call.headers));
              return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
            },
          },
          POOL_SERVICE: { fetch: async () => new Response(null, { status: 503 }) },
        },
        access,
        () => {},
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/native/v1/tunnel`;
  return {
    tools,
    opens,
    transport: (): ConnectionTransport => ({
      mode: "device",
      capabilities: ["models", "tools"],
      open: (request, signal) => {
        opens.push(request);
        return openTunnel(deviceSocket(url, "synthetic-native"), request, signal);
      },
    }),
    close: async () => {
      for (const peer of sockets.clients) peer.terminate();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("a 2026-07-28 tools/list behind a device reaches the tools service with its routing headers", async () => {
  const remote = await tunnelServer();
  const local = await gateway(remote.transport);
  try {
    const response = await local.post("/mcp", listing, listBody);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).result, { tools: [] });
    assert.equal(remote.tools.length, 1);
    assert.equal(remote.tools[0]?.get("mcp-method"), "tools/list");
    assert.equal(remote.tools[0]?.get("mcp-protocol-version"), "2026-07-28");
    assert.equal(remote.tools[0]?.get("user-agent"), "synthetic-mcp-client/1.0");

    // A model call through the same gateway opens with the fixed set: no user agent, no routing.
    const model = await local.post(
      "/v1/messages",
      { ...listing, "anthropic-version": "2023-06-01" },
      JSON.stringify({ model: "synthetic-model" }),
    );
    await model.body?.cancel();
    assert.deepEqual(remote.opens.at(-1)?.headers, {
      accept: listing.accept,
      "content-type": listing["content-type"],
      "mcp-protocol-version": listing["mcp-protocol-version"],
      "anthropic-version": "2023-06-01",
    });
  } finally {
    await local.close();
    await remote.close();
  }
});

test("the direct forward carries the same headers and relays MCP response headers", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers);
    request.resume();
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "synthetic-session",
      "mcp-synthetic": "relayed",
      "x-other": "dropped",
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const local = await gateway(() => ({
    mode: "direct",
    credentials: {
      tools: {
        origin: `http://127.0.0.1:${address.port}`,
        path: "/mcp",
        token: "ext_synthetic-tools-key",
      },
    },
  }));
  try {
    const response = await local.post("/mcp", listing, listBody);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-synthetic"), "relayed");
    assert.equal(response.headers.get("x-other"), null);
    await response.body?.cancel();
    assert.equal(seen[0]?.["mcp-method"], "tools/list");
    assert.equal(seen[0]?.["user-agent"], "synthetic-mcp-client/1.0");
    assert.equal(seen[0]?.authorization, "Bearer ext_synthetic-tools-key");

    const routes = Object.fromEntries(
      Array.from({ length: maximumMcpHeaders }, (_, index) => [`mcp-param-p${index}`, "v"]),
    );
    const refused = await local.post("/mcp", { ...listing, ...routes }, listBody);
    assert.equal(refused.status, 502);
    assert.equal(refused.headers.get("x-should-retry"), "false");
    const body = await refused.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.match(body.error.message, /headers exceed/u);
    assert.equal(seen.length, 1, "A refused call never reaches the tools service.");
  } finally {
    await local.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
