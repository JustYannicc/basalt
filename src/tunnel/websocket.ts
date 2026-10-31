import {
  encodeTunnelBytes,
  tunnelLimits,
  type TunnelServerFrame,
} from "../../clients/contracts/tunnel.ts";
import type { TunnelOutput } from "./flow.ts";
import type { TunnelSocket } from "./platform.ts";

/** A provider cannot be paused by WebSocket.send; close instead of buffering beyond one window. */
export class TunnelWebSocket {
  private socket: TunnelSocket;
  private output: TunnelOutput;
  private send: (frame: TunnelServerFrame) => void;
  private id: number;
  private fail: () => void;
  private stopped = false;
  private queued: { bytes: Uint8Array; text: boolean }[] = [];
  private queuedBytes = 0;
  private running = false;
  private incoming: Uint8Array[] = [];
  private incomingBytes = 0;
  private incomingText: boolean | undefined;
  private received = 0;
  constructor(
    socket: TunnelSocket,
    id: number,
    output: TunnelOutput,
    send: (frame: TunnelServerFrame) => void,
    fail: () => void,
    ended: () => void,
  ) {
    this.socket = socket;
    this.id = id;
    this.output = output;
    this.send = send;
    this.fail = fail;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      try {
        const data: unknown = event.data;
        const text = typeof data === "string";
        if (!text && !(data instanceof ArrayBuffer)) throw new Error("Invalid model socket data");
        const bytes = text ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
        if (!bytes.length || bytes.length + this.queuedBytes > tunnelLimits.windowBytes)
          throw new Error("Model socket buffer exceeded");
        this.queued.push({ bytes, text });
        this.queuedBytes += bytes.length;
        void this.flush();
      } catch {
        fail();
      }
    });
    socket.addEventListener("close", ended);
    socket.addEventListener("error", fail);
    socket.accept();
  }
  receive(bytes: Uint8Array, text: boolean, more: boolean) {
    if (this.stopped || (this.incomingText !== undefined && text !== this.incomingText))
      throw new Error("Invalid model message continuation");
    this.incomingText = text;
    this.incomingBytes += bytes.length;
    this.received += bytes.length;
    if (
      this.incomingBytes > tunnelLimits.windowBytes ||
      this.received > tunnelLimits.websocketRequestBytes
    )
      throw new Error("Model socket request limit exceeded");
    this.incoming.push(bytes);
    if (more) return;
    const message = new Uint8Array(this.incomingBytes);
    let offset = 0;
    for (const part of this.incoming) {
      message.set(part, offset);
      offset += part.length;
    }
    this.socket.send(
      text ? new TextDecoder("utf-8", { fatal: true }).decode(message) : message.buffer,
    );
    this.send({ v: 1, type: "credit", id: this.id, bytes: this.incomingBytes });
    this.incoming = [];
    this.incomingBytes = 0;
    this.incomingText = undefined;
  }
  stop() {
    this.stopped = true;
    this.queued = [];
    this.incoming = [];
    this.queuedBytes = 0;
    try {
      this.socket.close(1000, "Operation ended");
    } catch {}
  }
  private async flush() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queued.length && !this.stopped) {
        const next = this.queued[0]!;
        let offset = 0;
        while (offset < next.bytes.length) {
          const size = Math.min(await this.output.capacity(), next.bytes.length - offset);
          if (this.stopped) return;
          this.output.take(size);
          this.send({
            v: 1,
            type: "data",
            id: this.id,
            text: next.text,
            bytes: encodeTunnelBytes(next.bytes.subarray(offset, offset + size)),
            more: offset + size < next.bytes.length,
          });
          offset += size;
        }
        this.queued.shift();
        this.queuedBytes -= next.bytes.length;
      }
    } catch {
      if (!this.stopped) this.fail();
    } finally {
      this.running = false;
    }
  }
}
