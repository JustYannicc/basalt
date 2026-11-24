import type { Registry } from "./computer-registry.ts";

/**
 * Calls a revocation or protection abort cut, held in this instance's memory so a resume of one is
 * refused. Ids are unique per call; past this many the oldest are forgotten.
 */
const cutLimit = 4_096;

/** Leases are installed under the registry queue before a model request can start. */
export class NativeStreams {
  private leases = new Set<{
    computer: string;
    pool: string;
    abort: AbortController;
    close?: () => void;
    call?: string;
  }>();
  private cut = new Set<string>();
  get active() {
    return this.leases.size;
  }
  /** Whether this instance deliberately ended the call with this request id. */
  wasCut(call: string) {
    return this.cut.has(call);
  }
  private end(lease: { abort: AbortController; close?: () => void; call?: string }) {
    if (lease.call !== undefined) {
      this.cut.delete(lease.call);
      this.cut.add(lease.call);
      if (this.cut.size > cutLimit) this.cut.delete(this.cut.values().next().value!);
    }
    lease.abort.abort();
    lease.close?.();
  }
  abortAll() {
    for (const lease of this.leases) this.end(lease);
    this.leases.clear();
  }
  abortPool(pool: string) {
    for (const lease of this.leases) {
      if (lease.pool !== pool) continue;
      this.end(lease);
      this.leases.delete(lease);
    }
  }
  sync(registry: Registry) {
    for (const lease of this.leases) {
      const row = registry[lease.computer];
      if (row?.state === "active" && !row.removalPending && row.pool === lease.pool) continue;
      this.end(lease);
      this.leases.delete(lease);
    }
  }
  /** `call` names the model call the lease serves, so a deliberate end of it is remembered. */
  acquire(computer: string, pool: string, signal: AbortSignal, call?: string) {
    const lease = {
      computer,
      pool,
      abort: new AbortController(),
      close: undefined as (() => void) | undefined,
      ...(call === undefined ? {} : { call }),
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
export type NativeStreamLease = ReturnType<NativeStreams["acquire"]> & {
  failed?(error: unknown): void | Promise<void>;
};
