/** Cloudflare's upgrade extensions stay at the edge of the transport. */
export interface TunnelSocket extends Pick<
  WebSocket,
  "send" | "close" | "binaryType" | "addEventListener"
> {
  accept(): void;
}
type UpgradeResponse = Response & { webSocket: TunnelSocket | null };
type Pair = { 0: TunnelSocket; 1: TunnelSocket };
export function tunnelPair(): Pair {
  const runtime = globalThis as typeof globalThis & { WebSocketPair: new () => Pair };
  return new runtime.WebSocketPair();
}
export const upgradedSocket = (response: Response) => (response as UpgradeResponse).webSocket;
export function tunnelUpgrade(socket: TunnelSocket, protocol: string) {
  const init: ResponseInit & { webSocket: TunnelSocket } = {
    status: 101,
    headers: { "sec-websocket-protocol": protocol },
    webSocket: socket,
  };
  return new Response(null, init);
}
