import type { Bytes } from "../shared/strata/types.ts";
import { ProtocolError, Unavailable } from "./wire.ts";

/** Counts owned byte buffers, including allocations which overlap while a window grows. */
export class RetainedBytes {
  private sizes = new Map<object, number>();
  private report: ((bytes: number) => void) | undefined;
  constructor(report?: (bytes: number) => void) {
    this.report = report;
  }
  set(owner: object, bytes: number) {
    this.sizes.set(owner, bytes);
    this.report?.([...this.sizes.values()].reduce((sum, size) => sum + size, 0));
  }
}

/** A pull-driven window. Consumed bytes and their backing allocations are released together. */
export class StreamWindow {
  bytes: Bytes = new Uint8Array();
  ended = false;
  private tail: Bytes = new Uint8Array();
  private tailOwner = {};
  private source: AsyncIterator<Bytes>;
  private retained: RetainedBytes;
  constructor(source: AsyncIterator<Bytes>, retained: RetainedBytes) {
    this.source = source;
    this.retained = retained;
  }
  async ensure(length: number) {
    if (this.bytes.length >= length || this.ended) return;
    const next = new Uint8Array(length);
    this.retained.set(this, this.bytes.buffer.byteLength + next.byteLength);
    next.set(this.bytes);
    let at = this.bytes.length;
    this.bytes = next;
    while (at < length) {
      if (!this.tail.length) {
        const part = await this.source.next();
        if (part.done) {
          this.ended = true;
          break;
        }
        this.tail = part.value;
        this.retained.set(this.tailOwner, this.tail.buffer.byteLength);
      }
      const count = Math.min(length - at, this.tail.length);
      next.set(this.tail.subarray(0, count), at);
      this.tail = this.tail.subarray(count);
      if (!this.tail.length) this.tail = new Uint8Array();
      at += count;
    }
    this.bytes = next.subarray(0, at);
    this.retained.set(this, next.byteLength);
    if (!this.tail.length) this.retained.set(this.tailOwner, 0);
  }
  consume(length: number) {
    const rest = this.bytes.subarray(length);
    // Compact only when most of the backing buffer is consumed, rather than copying a large
    // lookahead window once for every tiny entry header.
    if (rest.length < this.bytes.buffer.byteLength / 4) {
      this.retained.set(this, this.bytes.buffer.byteLength + rest.byteLength);
      this.bytes = rest.slice();
    } else this.bytes = rest;
    this.retained.set(this, this.bytes.buffer.byteLength);
  }
  async require(length: number) {
    await this.ensure(length);
    if (this.bytes.length < length) throw new ProtocolError("Truncated Git stream");
  }
  async close() {
    await this.source.return?.();
    this.bytes = this.tail = new Uint8Array();
    this.retained.set(this, 0);
    this.retained.set(this.tailOwner, 0);
  }
}

export async function* responseBytes(body: ReadableStream<Bytes> | null) {
  const reader = body?.getReader();
  if (!reader) throw new ProtocolError("Missing Git response body");
  try {
    for (;;) {
      let part: ReadableStreamReadResult<Bytes>;
      try {
        part = await reader.read();
      } catch {
        throw new Unavailable("Git remote response interrupted");
      }
      if (part.done) return;
      if (part.value.length) yield part.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
