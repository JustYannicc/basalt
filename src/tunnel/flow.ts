import { tunnelLimits } from "../../clients/contracts/tunnel.ts";

/** Receiver credit is returned only after the downstream stream pulls a chunk. */
export class TunnelInput {
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private credit = tunnelLimits.windowBytes as number;
  private queued: Uint8Array[] = [];
  private waiting = false;
  private ended = false;
  private stopped = false;
  private received = 0;
  private consumed: (bytes: number) => void;
  constructor(consumed: (bytes: number) => void) {
    this.consumed = consumed;
    this.stream = new ReadableStream(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: () => {
          this.waiting = true;
          this.deliver();
        },
        cancel: () => {
          this.stopped = true;
          this.queued = [];
        },
      },
      { highWaterMark: 0 },
    );
  }
  push(bytes: Uint8Array) {
    if (bytes.length === 0 || this.ended || this.stopped || bytes.length > this.credit)
      throw new Error("Request credit exceeded");
    this.received += bytes.length;
    if (this.received > tunnelLimits.requestBytes) throw new Error("Request exceeds its limit");
    this.credit -= bytes.length;
    this.queued.push(bytes);
    this.deliver();
  }
  end() {
    if (this.ended) throw new Error("Request already ended");
    this.ended = true;
    this.deliver();
  }
  abort() {
    if (this.stopped) return;
    this.stopped = true;
    this.queued = [];
    this.controller.error(new Error("Tunnel interrupted"));
  }
  private deliver() {
    if (this.stopped || !this.waiting) return;
    const chunk = this.queued.shift();
    if (chunk) {
      this.waiting = false;
      this.credit += chunk.length;
      this.controller.enqueue(chunk);
      this.consumed(chunk.length);
    } else if (this.ended) {
      this.stopped = true;
      this.controller.close();
    }
  }
}

/** Repeated credits cannot acknowledge bytes that were never sent. */
export class TunnelOutput {
  private available = 0;
  private outstanding = 0;
  private initialized = false;
  private wake: (() => void) | undefined;
  private stopped = false;
  grant(bytes: number) {
    if (this.initialized && bytes > this.outstanding) throw new Error("Unbacked response credit");
    if (this.available + bytes > tunnelLimits.windowBytes)
      throw new Error("Response credit exceeded");
    if (this.initialized) this.outstanding -= bytes;
    this.initialized = true;
    this.available += bytes;
    this.wake?.();
  }
  async capacity() {
    while (!this.stopped && this.available === 0)
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    this.wake = undefined;
    if (this.stopped) throw new Error("Tunnel interrupted");
    return Math.min(this.available, tunnelLimits.chunkBytes);
  }
  take(bytes: number) {
    if (bytes > this.available) throw new Error("Response credit exceeded");
    this.available -= bytes;
    this.outstanding += bytes;
  }
  abort() {
    this.stopped = true;
    this.wake?.();
  }
}
