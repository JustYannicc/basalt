import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { decodeTunnelFrame, tunnelLimits } from "../contracts/tunnel.ts";
import type { Capability, ConnectionTransport } from "../contracts/connection.ts";
import type { ClientOperation } from "../contracts/transport.ts";

type DeviceTransport = Extract<ConnectionTransport, { mode: "device" }>;
function operation(
  incoming: IncomingMessage,
  transport: DeviceTransport,
  capability: Capability,
  signal: AbortSignal,
  websocket = false,
) {
  const headers: Record<string, string> = {};
  const url = new URL(incoming.url ?? "/", "http://localhost");
  for (const key of [
    "accept",
    "content-type",
    "content-encoding",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
    "anthropic-version",
    "anthropic-beta",
    "openai-beta",
  ]) {
    const value = incoming.headers[key];
    if (typeof value === "string") headers[key] = value;
  }
  const checked = decodeTunnelFrame(
    JSON.stringify({
      v: 1,
      type: "open",
      id: 1,
      headers,
      operation: {
        service: capability,
        method: incoming.method,
        // Keep existing refusals in the literal-path decoder when no search was supplied.
        path: url.search ? url.pathname : incoming.url,
        ...(capability === "models" && url.search ? { search: url.search } : {}),
        transport: websocket ? "websocket" : "http",
      },
    }),
    "client",
  );
  if (checked.type !== "open") throw new Error("Unsupported tunnel operation.");
  return transport.open(checked, signal);
}
const write = (outgoing: ServerResponse, bytes: Uint8Array) =>
  new Promise<void>((resolve, reject) => {
    outgoing.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
export async function forwardTunnelHttp(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  transport: DeviceTransport,
  capability: Capability,
  signal: AbortSignal,
) {
  const remote = operation(incoming, transport, capability, signal);
  const upload = (async () => {
    for await (const chunk of incoming) {
      const bytes: Buffer = chunk;
      if (incoming.method !== "POST" && bytes.length)
        throw new Error("This operation takes no body.");
      await remote.send(bytes);
    }
    await remote.end();
  })();
  void upload.catch(() => remote.close());
  try {
    const response = await remote.response;
    outgoing.writeHead(response.status, response.headers);
    outgoing.flushHeaders();
    for (;;) {
      const part = await remote.next();
      if (!part) break;
      await write(outgoing, part.bytes);
      remote.consumed(part.bytes.length);
    }
    outgoing.end();
  } finally {
    remote.close();
  }
}

export async function forwardTunnelWebsocket(
  incoming: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  transport: DeviceTransport,
  signal: AbortSignal,
) {
  const remote = operation(incoming, transport, "models", signal, true);
  let local: Awaited<ReturnType<typeof accept>> | undefined;
  try {
    const response = await remote.response;
    if (response.status !== 101) {
      const lines = [`HTTP/1.1 ${response.status} Remote response`, "Connection: close"];
      for (const [key, value] of Object.entries(response.headers)) lines.push(`${key}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      for (;;) {
        const part = await remote.next();
        if (!part) break;
        await new Promise<void>((resolve, reject) =>
          socket.write(part.bytes, (error) => (error ? reject(error) : resolve())),
        );
        remote.consumed(part.bytes.length);
      }
      socket.end();
      return;
    }
    local = await accept(incoming, socket, head);
    const peer = local;
    let pending = Promise.resolve(),
      queued = 0;
    peer.on("message", (value, binary) => {
      const bytes = Array.isArray(value)
        ? Buffer.concat(value)
        : value instanceof ArrayBuffer
          ? Buffer.from(value)
          : value;
      queued += Math.max(1, bytes.length);
      if (queued > tunnelLimits.windowBytes) {
        remote.close();
        peer.terminate();
        return;
      }
      peer.pause();
      pending = pending
        .then(() => remote.send(bytes, !binary, true))
        .then(() => {
          queued -= Math.max(1, bytes.length);
          if (!queued) peer.resume();
        });
      void pending.catch(() => {
        remote.close();
        peer.terminate();
      });
    });
    peer.on("close", () => {
      remote.close();
    });
    peer.on("error", () => {
      remote.close();
    });
    await receiveMessages(remote, async (bytes, text) => {
      await new Promise<void>((resolve, reject) =>
        peer.send(bytes, { binary: !text }, (error) => (error ? reject(error) : resolve())),
      );
    });
    await new Promise<void>((resolve) => {
      if (peer.readyState === peer.CLOSED) return resolve();
      peer.once("close", resolve);
      peer.close(1000, "Remote operation ended");
    });
  } finally {
    remote.close();
    local?.terminate();
  }
}
function accept(incoming: IncomingMessage, socket: Duplex, head: Buffer) {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: tunnelLimits.windowBytes,
    perMessageDeflate: false,
  });
  return new Promise<import("ws").WebSocket>((resolve, reject) => {
    server.once("error", reject);
    server.handleUpgrade(incoming, socket, head, (peer) => {
      server.close();
      resolve(peer);
    });
  });
}
async function receiveMessages(
  remote: ClientOperation,
  deliver: (bytes: Uint8Array, text: boolean) => Promise<void>,
) {
  let parts: Uint8Array[] = [],
    size = 0,
    text: boolean | undefined;
  for (;;) {
    const part = await remote.next();
    if (!part) {
      if (parts.length) throw new Error("Truncated remote message.");
      return;
    }
    if (text !== undefined && text !== part.text) throw new Error("Invalid message continuation.");
    text = part.text;
    size += part.bytes.length;
    if (size > tunnelLimits.windowBytes || (part.more && !part.bytes.length))
      throw new Error("Remote message exceeds its limit.");
    parts.push(part.bytes);
    if (part.more) continue;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of parts) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (text) new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    await deliver(bytes, text);
    if (size) remote.consumed(size);
    parts = [];
    size = 0;
    text = undefined;
  }
}
