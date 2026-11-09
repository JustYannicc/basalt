import type { NativeStreamLease } from "../native-streams.ts";

interface Entry {
  pool: string;
  slot?: string;
  abort: AbortController;
  close?: () => void;
}

/** Pending admission registers before authority reads, including a transaction retry. */
export class SlotStreams {
  private entries = new Set<Entry>();
  acquire(pool: string, signal: AbortSignal) {
    const entry: Entry = { pool, abort: new AbortController() };
    this.entries.add(entry);
    const lease: NativeStreamLease = {
      signal: AbortSignal.any([signal, entry.abort.signal]),
      release: () => this.entries.delete(entry),
      onClose: (close) => {
        entry.close = close;
        if (entry.abort.signal.aborted || signal.aborted) close();
      },
    };
    return {
      lease,
      bind: (slot: string) => {
        entry.slot = slot;
      },
    };
  }
  private abort(predicate: (entry: Entry) => boolean) {
    for (const entry of this.entries) {
      if (!predicate(entry)) continue;
      entry.abort.abort();
      entry.close?.();
      this.entries.delete(entry);
    }
  }
  abortPool(pool: string) {
    this.abort((entry) => entry.pool === pool);
  }
  abortSlot(slot: string) {
    this.abort((entry) => entry.slot === slot);
  }
  active(slot: string) {
    return [...this.entries].filter((entry) => entry.slot === slot || entry.slot === undefined)
      .length;
  }
  forSlot(slot: string) {
    const active = () => [...this.entries].filter((entry) => entry.slot === slot).length;
    return {
      get active() {
        return active();
      },
      abortAll: () => this.abortSlot(slot),
    };
  }
}
