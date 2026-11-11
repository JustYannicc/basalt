import { connectionUrl, refreshSession, type Session } from "./auth.ts";
import { json, object, type Http, type HttpReply } from "./http.ts";
export class RemoteToolError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}
function envelope(reply: HttpReply, id: number) {
  if (reply.status < 200 || reply.status >= 300)
    throw new Error(
      reply.status === 401 || reply.status === 403
        ? "Device access was removed or expired. Reconnect in Signalbox."
        : `Cloud request failed (${reply.status})`,
    );
  let value: unknown;
  if (reply.headers["content-type"]?.includes("text/event-stream")) {
    if (reply.body.length > 16 * 1024 * 1024)
      throw new Error("Cloud reply exceeds the device limit");
    for (const frame of reply.body.split(/\r?\n\r?\n/u)) {
      const data = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const item = object(JSON.parse(data));
      if (item.method && item.id !== undefined)
        throw new Error("The cloud app asked for an unsupported device prompt");
      if (item.id === id) value = item;
    }
  } else value = json(reply, 16 * 1024 * 1024);
  const data = object(value);
  if (data.id !== id || data.error !== undefined) throw new Error("Cloud protocol request failed");
  return object(data.result);
}
export function createTransport(input: {
  http: Http;
  session: Session;
  appSlug: string;
  appId?: string;
  saveSession: (session: Session) => Promise<void>;
  allowLoopback?: boolean;
}) {
  if (!/^[A-Za-z0-9_-]+$/u.test(input.appSlug)) throw new Error("Invalid cloud app identity");
  const resource = connectionUrl(input.session.resource, input.allowLoopback),
    http = input.http;
  let session = { ...input.session },
    sessionId: string | null = null,
    initialized = false,
    initializing: Promise<void> | null = null,
    sequence = 0;
  const credentials = async () => {
    if (session.expiresAt - Date.now() < 30_000) {
      session = await refreshSession(http, session);
      await input.saveSession(session);
    }
    return session.accessToken;
  };
  const post = async (body: unknown) => {
    const token = await credentials();
    const reply = await http(resource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (reply.status === 404) {
      initialized = false;
      sessionId = null;
    }
    return reply;
  };
  const initialize = async () => {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = (async () => {
      const id = ++sequence,
        reply = await post({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: { elicitation: { form: {} } },
            clientInfo: { name: "basalt-obsidian-sync", version: "0.1.0" },
          },
        });
      const result = envelope(reply, id);
      if (result.protocolVersion !== "2025-11-25")
        throw new Error("Signalbox does not support this device protocol");
      sessionId = reply.headers["mcp-session-id"] ?? null;
      const ready = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      if (ready.status !== 202 && ready.status !== 200 && ready.status !== 204)
        throw new Error("Cloud session did not initialize");
      initialized = true;
    })().finally(() => {
      initializing = null;
    });
    return initializing;
  };
  const call = async (tool: string, args: unknown) => {
    await initialize();
    const id = ++sequence,
      path = input.appId === undefined ? `tools[${JSON.stringify(input.appSlug)}].${tool}` : tool;
    const result = envelope(
      await post({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "call",
          arguments: {
            calls: {
              path,
              ...(input.appId === undefined ? {} : { app: input.appId }),
              input: args,
            },
          },
        },
      }),
      id,
    );
    let payload: unknown = result.structuredContent;
    if (payload === undefined && Array.isArray(result.content))
      for (const value of result.content) {
        const item = object(value);
        if (item.type === "text" && typeof item.text === "string") {
          payload = JSON.parse(item.text);
          break;
        }
      }
    const outcome = object(payload);
    if (outcome.status !== "completed")
      throw new Error("Cloud sync did not complete. No local changes were discarded.");
    const execution = object(outcome.execution);
    if (execution.ok !== true) throw new Error("Cloud sync execution failed");
    const value = object(execution.value);
    if (value.path !== path) throw new Error("Cloud returned a result for another tool");
    if (value.ok !== true) {
      const error = object(value.error);
      throw new RemoteToolError(
        typeof error.kind === "string" ? error.kind : "ToolFailure",
        typeof error.message === "string" ? error.message : "Cloud sync was refused",
      );
    }
    return value.value;
  };
  return {
    call,
    async close() {
      if (!sessionId) return;
      try {
        await http(resource, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${await credentials()}`,
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-11-25",
          },
        });
      } finally {
        sessionId = null;
        initialized = false;
      }
    },
  };
}
