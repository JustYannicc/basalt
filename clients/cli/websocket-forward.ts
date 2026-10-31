import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServiceCredentials } from "../contracts/connection.ts";
import { forwardedResponseHeaders } from "./http-forward.ts";

export async function forwardWebsocket(
  incoming: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  service: NonNullable<ServiceCredentials["models"]>,
  signal: AbortSignal,
): Promise<void> {
  const target = new URL("/v1/responses", service.origin);
  const headers: Record<string, string> = {
    authorization: `Bearer ${service.token}`,
    connection: "Upgrade",
    upgrade: "websocket",
  };
  for (const name of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
    "openai-beta",
  ])
    if (typeof incoming.headers[name] === "string") headers[name] = incoming.headers[name];
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const remote = transport(target, { method: "GET", headers, signal });
    let upstream: Duplex | undefined;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      remote.destroy();
      socket.destroy();
      upstream?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish();
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", abort);
    socket.once("error", finish);
    remote.once("error", finish);
    remote.once("response", (response) => {
      remote.setTimeout(0);
      const lines = [
        `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Remote response"}`,
        "Connection: close",
      ];
      for (const [name, value] of forwardedResponseHeaders(response.headers))
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      void pipeline(response, socket, { signal }).then(() => finish(), finish);
    });
    remote.once("upgrade", (response, peer, received) => {
      upstream = peer;
      remote.setTimeout(0);
      const lines = [
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
      ];
      for (const name of [
        "sec-websocket-accept",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
      ])
        if (typeof response.headers[name] === "string")
          lines.push(`${name}: ${response.headers[name]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (received.length) socket.write(received);
      if (head.length) peer.write(head);
      peer.once("error", finish);
      peer.once("close", abort);
      socket.pipe(peer).pipe(socket);
    });
    remote.setTimeout(30_000, () =>
      remote.destroy(new Error("WebSocket handshake deadline exceeded.")),
    );
    remote.end();
  });
}
