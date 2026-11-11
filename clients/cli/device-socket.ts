import { WebSocket } from "ws";
import { tunnelProtocol, tunnelLimits } from "../contracts/tunnel.ts";
import type { SocketFactory } from "../contracts/transport.ts";

export const deviceSocket: SocketFactory = (url, token) => {
  const socket = new WebSocket(url, tunnelProtocol, {
    headers: { authorization: `Bearer ${token}` },
    maxPayload: tunnelLimits.frameBytes,
    perMessageDeflate: false,
    handshakeTimeout: 30_000,
    followRedirects: false,
  });
  return {
    send: (value) => {
      socket.send(value);
    },
    close: () => {
      socket.terminate();
    },
    listen: (listener) => {
      const message = (data: import("ws").RawData, binary: boolean) =>
        listener({ type: "message", data: binary ? data : data.toString() });
      const close = (code: number) => listener({ type: "close", code });
      const error = () => listener({ type: "error" });
      const refused = (_request: unknown, response: import("node:http").IncomingMessage) => {
        listener({ type: "error", status: response.statusCode });
        response.resume();
        socket.terminate();
      };
      socket.on("message", message);
      socket.on("close", close);
      socket.on("error", error);
      socket.on("unexpected-response", refused);
      return () => {
        socket.off("message", message);
        socket.off("close", close);
        // terminate during CONNECTING can emit an asynchronous error after cleanup.
        socket.off("error", error);
        socket.off("unexpected-response", refused);
        socket.on("error", () => undefined);
      };
    },
  };
};
