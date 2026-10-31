import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import type { ServiceCredentials } from "../contracts/connection.ts";

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
    const abort = () => {
      socket.destroy();
      remote.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    remote.once("error", reject);
    remote.once("response", (response) => {
      socket.end(
        `HTTP/1.1 ${response.statusCode ?? 502} Connection refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      response.destroy();
      finish();
    });
    remote.once("upgrade", (response, upstream, received) => {
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
      if (head.length) upstream.write(head);
      const close = () => {
        socket.destroy();
        upstream.destroy();
        finish();
      };
      signal.addEventListener("abort", close, { once: true });
      upstream.once("error", close);
      socket.once("error", close);
      upstream.once("close", close);
      socket.once("close", close);
      socket.pipe(upstream).pipe(socket);
    });
    remote.setTimeout(30_000, () =>
      remote.destroy(new Error("WebSocket handshake deadline exceeded.")),
    );
    remote.end();
  });
}
