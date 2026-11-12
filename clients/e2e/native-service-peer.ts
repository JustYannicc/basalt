import { WebSocket } from "ws";

export interface NativeServiceRequest {
  operation: { service: string; method: string; path: string; transport: string };
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}
interface Reply {
  status: number;
  headers?: Record<string, string>;
  chunks?: readonly Uint8Array[] | AsyncIterable<Uint8Array>;
}
export type NativeServices = (request: NativeServiceRequest) => Reply | Promise<Reply>;

/** Custom external peers stream one credited chunk at a time, including delayed model headers. */
export function servicePeer(
  peer: WebSocket,
  services: NativeServices,
  response: (status: number, headers?: Record<string, string>) => void,
  data: (bytes: Buffer, text?: boolean, message?: boolean, end?: boolean) => void,
  drained: () => Promise<void>,
  end: () => void,
) {
  const controller = new AbortController();
  const closed = new Promise<void>((resolve) =>
    peer.once("close", () => {
      controller.abort();
      resolve();
    }),
  );
  peer.once("error", () => controller.abort());
  return async (request: Omit<NativeServiceRequest, "signal">, handshake = false) => {
    try {
      const result = await services({ ...request, signal: controller.signal });
      if (controller.signal.aborted) return;
      const websocket = request.operation.transport === "websocket";
      if (!websocket || handshake) response(result.status, result.headers);
      if (handshake && result.status === 101) return;
      for await (const chunk of result.chunks ?? []) {
        if (controller.signal.aborted) return;
        data(Buffer.from(chunk), websocket, websocket);
        if (peer.readyState !== WebSocket.OPEN) return;
        // The native peer waits for the gateway's credit, rather than buffering a complete body.
        await Promise.race([drained(), closed]);
      }
      if (!websocket || result.status !== 101) end();
    } catch (error) {
      if (!controller.signal.aborted) {
        peer.terminate();
        throw error;
      }
    }
  };
}
