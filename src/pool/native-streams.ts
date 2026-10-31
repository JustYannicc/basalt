import type { Registry } from "./computer-registry.ts";

/** Leases are installed under the registry queue before a model request can start. */
export class NativeStreams {
  private leases = new Set<{
    computer: string;
    pool: string;
    abort: AbortController;
    close?: () => void;
  }>();
  sync(registry: Registry) {
    for (const lease of this.leases) {
      const row = registry[lease.computer];
      if (row?.state === "active" && !row.removalPending && row.pool === lease.pool) continue;
      lease.abort.abort();
      lease.close?.();
      this.leases.delete(lease);
    }
  }
  acquire(computer: string, pool: string, signal: AbortSignal) {
    const lease = {
      computer,
      pool,
      abort: new AbortController(),
      close: undefined as (() => void) | undefined,
    };
    this.leases.add(lease);
    const release = () => this.leases.delete(lease);
    return {
      signal: AbortSignal.any([signal, lease.abort.signal]),
      release,
      onClose: (close: () => void) => {
        lease.close = close;
        if (lease.abort.signal.aborted || signal.aborted) close();
      },
    };
  }
}
export type NativeStreamLease = ReturnType<NativeStreams["acquire"]>;
