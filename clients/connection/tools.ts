import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { CredentialSource } from "../contracts/connection.ts";
import { cloudRequest, serverEvents } from "./request.ts";

export class ToolCallError extends Error {
  readonly result: unknown;
  constructor(result: unknown) {
    super("The tool returned an error. Read its result before trying again.");
    this.result = result;
  }
}
/** Streamable HTTP over the native tunnel. A broken request is never resumed or replayed. */
class ToolsTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  sessionId?: string;
  private version?: string;
  private readonly controller = new AbortController();
  private closed = false;
  private readonly source: CredentialSource;
  private readonly signal: AbortSignal;
  constructor(source: CredentialSource, signal: AbortSignal) {
    this.source = source;
    this.signal = signal;
  }
  async start() {
    this.signal.throwIfAborted();
  }
  setProtocolVersion(version: string) {
    this.version = version;
  }
  async send(message: JSONRPCMessage) {
    if (this.closed) throw new Error("The tools connection is closed.");
    const response = await cloudRequest(
      this.source,
      {
        operation: { service: "tools", method: "POST", path: "/mcp", transport: "http" },
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          ...(this.version ? { "mcp-protocol-version": this.version } : {}),
        },
      },
      JSON.stringify(message),
      AbortSignal.any([this.signal, this.controller.signal]),
    );
    try {
      if (response.status < 200 || response.status >= 300)
        throw new Error(`The tools request failed (${response.status}). It was not replayed.`);
      this.sessionId = response.headers["mcp-session-id"] ?? this.sessionId;
      if (response.status === 202 || response.status === 204) return;
      if (response.headers["content-type"]?.startsWith("text/event-stream")) {
        for await (const event of serverEvents(response.chunks())) {
          this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(event)));
        }
      } else {
        this.onmessage?.(JSONRPCMessageSchema.parse(await response.json()));
      }
    } finally {
      response.close();
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.onclose?.();
  }
}

export async function connectTools(source: CredentialSource, signal: AbortSignal) {
  const client = new Client({ name: "signalbox-mobile", version: "0.1.0" }, { capabilities: {} });
  const transport = new ToolsTransport(source, signal);
  const abort = () => {
    void client.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await client.connect(transport, { signal });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: 120_000,
        maxTotalTimeout: 120_000,
      });
      if (result.isError) throw new ToolCallError(result);
      return result.structuredContent ?? result.content;
    };
    return {
      call,
      close: async () => {
        signal.removeEventListener("abort", abort);
        await client.close();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    await client.close();
    throw error;
  }
}
