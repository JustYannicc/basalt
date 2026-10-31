import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

/** External protocol fixtures exercise transport mechanics, not deployed model/tool acceptance. */
export async function remoteFixture() {
  const finishStream = deferred<void>();
  const cancelled = deferred<void>();
  const websocketBytes = deferred<Buffer>();
  let calls = 0,
    modelCalls = 0,
    slowBytes = 0;
  const slowTotal = 32 * 1024 * 1024;
  const server = createServer((request, response) => {
    void (async () => {
      const tools = request.url === "/mcp";
      if (
        tools
          ? request.headers.authorization !== "Bearer ext_synthetic-tools-key"
          : request.headers.authorization !== "Bearer synthetic-model-key" &&
            request.headers["x-api-key"] !== "synthetic-model-key"
      ) {
        response.writeHead(401).end();
        return;
      }
      if (tools) {
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        const mcp = new Server(
          { name: "transport-fixture", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: "echo",
              description: "Echo synthetic input",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async (input) => {
          calls++;
          return { content: [{ type: "text", text: JSON.stringify(input.params.arguments) }] };
        });
        const transport = new StreamableHTTPServerTransport({});
        await mcp.connect(transport);
        response.once("close", () => {
          void mcp.close();
        });
        await transport.handleRequest(request, response);
        return;
      }
      if (request.url === "/v1/responses/compact") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ compacted: true }));
        return;
      }
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] }));
        return;
      }
      const input = await body(request);
      modelCalls++;
      if (input.mode === "disconnect") {
        request.socket.destroy();
        return;
      }
      if (input.mode === "unknown") {
        response.writeHead(502, { "content-type": "application/json", "x-should-retry": "false" });
        response.end(JSON.stringify({ error: { code: "upstream_outcome_unknown", retryable: false } }));
        return;
      }
      if (input.mode === "error") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "17" });
        response.end(JSON.stringify({ error: "synthetic quota refusal" }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      if (input.mode === "stream") {
        await finishStream.promise;
        response.end("data: done\n\n");
      } else if (input.mode === "cancel") {
        response.once("close", () => cancelled.resolve());
      } else if (input.mode === "slow") {
        const chunk = Buffer.alloc(64 * 1024, 120);
        while (slowBytes < slowTotal && !response.destroyed) {
          slowBytes += chunk.length;
          if (!response.write(chunk)) await once(response, "drain");
        }
        response.end();
      } else response.end("data: done\n\n");
    })().catch(() => response.destroy());
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (request.headers.authorization !== "Bearer synthetic-model-key" || typeof key !== "string") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (request.headers["openai-beta"] === "fixture-refuse") {
      const body = JSON.stringify({ error: "synthetic handshake quota" });
      socket.end(
        `HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nRetry-After: 19\r\nSet-Cookie: private-fixture-cookie\r\n\r\n${body}`,
      );
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.once("data", (bytes: Buffer) => {
      websocketBytes.resolve(bytes);
      socket.write(Buffer.from([0x81, 5, ...Buffer.from("hello")]));
    });
    socket.on("error", () => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    finishStream,
    cancelled,
    websocketBytes,
    calls: () => calls,
    modelCalls: () => modelCalls,
    slowBytes: () => slowBytes,
    slowTotal,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
