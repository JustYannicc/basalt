import type { TunnelOpen, TunnelServerFrame } from "./tunnel.ts";

export type WireEvent = { type: "message"; data: unknown } | { type: "close" | "error" };
export interface WireSocket {
  send(value: string): void;
  close(): void;
  listen(listener: (event: WireEvent) => void): () => void;
}
export type SocketFactory = (url: string, token: string) => WireSocket;
export type TunnelPart = { bytes: Uint8Array; text: boolean; more: boolean };
export interface ClientOperation {
  response: Promise<Extract<TunnelServerFrame, { type: "response" }>>;
  send(bytes: Uint8Array, text?: boolean, message?: boolean): Promise<void>;
  end(): Promise<void>;
  next(): Promise<TunnelPart | undefined>;
  consumed(bytes: number): void;
  close(): void;
}
export type OpenOperation = Omit<TunnelOpen, "v" | "type" | "id">;
