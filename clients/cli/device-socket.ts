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
      const close = () => listener({ type: "close" });
      const error = () => listener({ type: "error" });
      socket.on("message", message);
      socket.on("close", close);
      socket.on("error", error);
      return () => {
        socket.off("message", message);
        socket.off("close", close);
        // terminate during CONNECTING can emit an asynchronous error after cleanup.
        socket.off("error", error);
        socket.on("error", () => undefined);
      };
    },
  };
};
