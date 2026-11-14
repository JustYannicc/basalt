import {
  encodeTunnelBytes,
  tunnelLimits,
  type TunnelServerFrame,
  type TunnelLimits,
} from "../../clients/contracts/tunnel.ts";
import type { TunnelOutput } from "./flow.ts";
import type { TunnelSocket } from "./platform.ts";
import { tunnelFailure, type TunnelFailure } from "./failure.ts";
import { ModelDrain } from "./model-drain.ts";

/** Provider sends cannot be paused; retain at most the negotiated message budget. */
export class TunnelWebSocket {
  private socket: TunnelSocket;
  private output: TunnelOutput;
  private send: (frame: TunnelServerFrame) => void;
  private id: number;
  private fail: (failure: TunnelFailure) => void;
  private stopped = false;
  private queued: { bytes: Uint8Array; text: boolean }[] = [];
  private queuedBytes = 0;
  private running = false;
  private incoming: Uint8Array[] = [];
  private incomingBytes = 0;
  private incomingText: boolean | undefined;
  private received = 0;
  private upstreamClosed = false;
  private ended: () => void;
  private limits: TunnelLimits;
  private drain: ModelDrain | undefined;
  private inputCredit: number = tunnelLimits.windowBytes;
  private pendingCredit = 0;
  constructor(
    socket: TunnelSocket,
    id: number,
    output: TunnelOutput,
    send: (frame: TunnelServerFrame) => void,
    fail: (failure: TunnelFailure) => void,
    ended: () => void,
    limits: TunnelLimits = tunnelLimits,
  ) {
    this.socket = socket;
    this.id = id;
    this.output = output;
    this.send = send;
    this.fail = fail;
    this.ended = ended;
    this.limits = limits;
    this.drain =
      limits.websocketMessageBytes === undefined
        ? undefined
        : new ModelDrain(socket, limits.websocketMessageBytes);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (this.stopped) return;
      try {
        const data: unknown = event.data;
        let bytes: Uint8Array, text: boolean;
        if (this.drain) {
          const message = this.drain.receive(data);
          if (!message) {
            if (this.drain.idle) this.releaseCredit();
            return;
          }
          ({ bytes, text } = message);
        } else {
          text = typeof data === "string";
          if (!text && !(data instanceof ArrayBuffer)) throw new Error("Invalid model socket data");
          bytes =
            typeof data === "string"
              ? new TextEncoder().encode(data)
              : new Uint8Array(data as ArrayBuffer);
        }
        if (
          Math.max(1, bytes.length) + this.queuedBytes > this.messageBytes ||
          (limits.websocketMessageBytes !== undefined && this.queued.length >= 256)
        )
          throw new Error("Model socket buffer exceeded");
        this.queued.push({ bytes, text });
        this.queuedBytes += Math.max(1, bytes.length);
        void this.flush();
      } catch (error) {
        if (!this.stopped) fail(tunnelFailure(error, "message", "message"));
      }
    });
    socket.addEventListener("close", () => {
      if (this.stopped) return;
      this.upstreamClosed = true;
      void this.flush();
    });
    socket.addEventListener("error", (event) => {
      // workerd can report a disconnect after Close while received output still waits for credit.
      if (!this.stopped && !this.upstreamClosed)
        fail(tunnelFailure("error" in event ? event.error : undefined, "socket", "error"));
    });
    socket.accept();
  }
  receive(bytes: Uint8Array, text: boolean, more: boolean) {
    if (bytes.length === 0 && more) throw new Error("Empty message continuation");
    if (this.stopped || (this.incomingText !== undefined && text !== this.incomingText))
      throw new Error("Invalid model message continuation");
    if (this.drain) {
      if (bytes.length > this.inputCredit) throw new Error("Model input credit exceeded.");
      this.inputCredit -= bytes.length;
      this.pendingCredit += bytes.length;
    }
    this.incomingText = text;
    this.incomingBytes += bytes.length;
    if (this.limits.websocketMessageBytes === undefined) this.received += bytes.length;
    if (
      this.incomingBytes > this.messageBytes ||
      (this.limits.websocketMessageBytes === undefined &&
        this.received > tunnelLimits.websocketRequestBytes)
    )
      throw new Error("Model socket request limit exceeded");
    this.incoming.push(bytes);
    if (more) {
      // v2 credit bounds transport chunks; the separate envelope bounds reassembly.
      if (this.drain?.idle) this.releaseCredit();
      return;
    }
    const message = new Uint8Array(this.incomingBytes);
    let offset = 0;
    for (const part of this.incoming) {
      message.set(part, offset);
      offset += part.length;
    }
    if (this.drain) {
      if (text) new TextDecoder("utf-8", { fatal: true }).decode(message);
      this.drain.send(message, text);
    } else {
      this.socket.send(
        text ? new TextDecoder("utf-8", { fatal: true }).decode(message) : message.buffer,
      );
      if (this.incomingBytes)
        this.send({ v: 1, type: "credit", id: this.id, bytes: this.incomingBytes });
    }
    this.incoming = [];
    this.incomingBytes = 0;
    this.incomingText = undefined;
  }
  private get messageBytes() {
    return this.limits.websocketMessageBytes ?? tunnelLimits.windowBytes;
  }
  private releaseCredit() {
    if (!this.pendingCredit) return;
    const bytes = this.pendingCredit;
    this.pendingCredit = 0;
    this.inputCredit += bytes;
    this.send({ v: 1, type: "credit", id: this.id, bytes });
  }
  stop() {
    this.stopped = true;
    this.queued = [];
    this.incoming = [];
    this.drain?.stop();
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
        if (next.bytes.length === 0)
          this.send({ v: 1, type: "data", id: this.id, text: next.text, bytes: "", more: false });
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
        this.queuedBytes -= Math.max(1, next.bytes.length);
      }
    } catch (error) {
      if (!this.stopped)
        this.fail(tunnelFailure(error, "flush", this.upstreamClosed ? "close" : "message"));
    } finally {
      this.running = false;
      if (this.upstreamClosed && this.queued.length === 0 && !this.stopped) this.ended();
    }
  }
}
