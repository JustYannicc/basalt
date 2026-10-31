import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export interface ProviderRequest {
  readonly authority: string;
  readonly method: string;
  readonly path: string;
}

/** Local HTTPS tunnel that never forwards synthetic OAuth requests to a provider. */
export class SyntheticOAuthProvider {
  private readonly native: ((request: IncomingMessage, response: ServerResponse, body: Buffer) => Promise<boolean>) | undefined;
  constructor(native?: (request: IncomingMessage, response: ServerResponse, body: Buffer) => Promise<boolean>) {
    this.native = native;
  }
  readonly requests: ProviderRequest[] = [];
  private directory = "";
  private certificate = "";
  private caBundle = "";
  private proxy = createHttpServer((_request, response) => {
    response.writeHead(405).end();
  });
  private https: HttpsServer | undefined;
  private sockets = new Set<Socket>();
  private origin = "";

  get url(): string {
    assert.ok(this.origin, "synthetic provider proxy has not started");
    return this.origin;
  }

  get poolContainerArgs(): string[] {
    assert.ok(this.caBundle, "synthetic provider proxy has not started");
    return [
      "--mount", `type=bind,source=${this.caBundle},target=/etc/ssl/certs/ca-certificates.crt,readonly`,
    ];
  }

  async start(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), "basalt-1420-provider-"));
    const key = join(this.directory, "key.pem");
    this.certificate = join(this.directory, "proxy.pem");
    this.caBundle = join(this.directory, "ca-bundle.pem");
    const cert = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", this.certificate,
      "-days", "2", "-subj", "/CN=Basalt synthetic provider", "-addext",
      "subjectAltName=DNS:api.anthropic.com,DNS:platform.claude.com,DNS:chatgpt.com,DNS:api.openai.com,DNS:auth.openai.com,DNS:cloudcode-pa.googleapis.com,DNS:api.typesafe.ai",
      "-addext", "basicConstraints=critical,CA:TRUE",
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(cert.status, 0, cert.error?.message ?? cert.stderr);
    const roots = await readSystemRoots();
    await writeFile(this.caBundle, Buffer.concat([roots, Buffer.from("\n"), await readFile(this.certificate)]), { mode: 0o644 });
    this.https = createHttpsServer({ key: await readFile(key), cert: await readFile(this.certificate) },
      (request, response) => this.respond(request, response));
    this.proxy.on("connection", (socket) => this.trackSocket(socket));
    this.proxy.on("connect", (request, socket, head) => {
      const authority = request.url ?? "";
      if (!new Set([
        "api.anthropic.com:443", "platform.claude.com:443", "chatgpt.com:443", "api.openai.com:443", "auth.openai.com:443", "cloudcode-pa.googleapis.com:443", "api.typesafe.ai:443",
      ]).has(authority.toLowerCase())) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: basalt-synthetic\r\n\r\n");
      if (head.length) socket.unshift(head);
      assert.ok(this.https, "synthetic TLS server has not started");
      this.https.emit("connection", socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.proxy.once("error", reject);
      this.proxy.listen(0, "0.0.0.0", resolve);
    });
    const address = this.proxy.address();
    assert.ok(address && typeof address !== "string");
    this.origin = `http://host.docker.internal:${address.port}`;
  }

  private trackSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authority = request.headers.host ?? "";
    const path = request.url ?? "/";
    const pathname = new URL(path, "https://synthetic.invalid").pathname;
    const method = request.method ?? "GET";
    this.requests.push({ authority, method, path });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    if (this.native && await this.native(request, response, raw)) return;
    const body = raw.toString();
    if (authority.startsWith("api.anthropic.com") && pathname === "/api/oauth/profile") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        account: { uuid: "synthetic-claude-account", email: "synthetic-claude@example.invalid" },
        organization: { uuid: "synthetic-claude-organization", name: "Synthetic Claude" },
      }));
      return;
    }
    if (authority.startsWith("api.anthropic.com") && pathname === "/api/oauth/claude_cli/roles") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ roles: [] }));
      return;
    }
    if (authority.startsWith("api.anthropic.com") && pathname === "/v1/messages") {
      const model = jsonString(body, "model", "claude-sonnet-4-5");
      const events = [
        ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ] as const;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [event, value] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      response.end();
      return;
    }
    if (authority.startsWith("cloudcode-pa.googleapis.com") && pathname === "/v1internal:streamGenerateContent") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ response: {
        candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        modelVersion: "gemini-2.5-pro", responseId: "fixture-gemini-response",
      } })}\n\n`);
      return;
    }
    if (authority.startsWith("chatgpt.com") && pathname.endsWith("/responses")) {
      const model = jsonString(body, "model", "gpt-5.5");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_fixture", object: "response", status: "in_progress", model } })}\n\n`);
      response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "OK" })}\n\n`);
      response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
        id: "resp_fixture", object: "response", status: "completed", model,
        output: [{ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } })}\n\n`);
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "synthetic endpoint not configured" }));
  }

  async close(): Promise<void> {
    try {
      const closed = this.proxy.listening
        ? new Promise<boolean>((resolve) => this.proxy.close(() => resolve(true)))
        : Promise.resolve(true);
      for (const socket of this.sockets) socket.destroy();
      this.proxy.closeAllConnections();
      this.https?.closeAllConnections();
      if (!await Promise.race([closed, delay(5_000).then(() => false)])) {
        for (const socket of this.sockets) socket.destroy();
        this.proxy.closeAllConnections();
        throw new Error("Synthetic provider proxy did not close within 5 seconds");
      }
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}

function jsonString(raw: string, key: string, fallback: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const field = (value as Record<string, unknown>)[key];
      if (typeof field === "string" && field.length) return field;
    }
  } catch {}
  return fallback;
}

async function readSystemRoots(): Promise<Buffer> {
  const candidates = process.platform === "darwin"
    ? ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"]
    : ["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem", "/etc/pki/tls/certs/ca-bundle.crt"];
  for (const path of candidates) {
    try { return await readFile(path); } catch {}
  }
  throw new Error("The host does not expose a PEM CA bundle for the synthetic pool fixture");
}
