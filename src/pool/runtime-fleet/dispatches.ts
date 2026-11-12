import { executionKey, type SlotIdentity } from "../runtime-slots/contract.ts";

type Reservation = { kind: "primary" } | { kind: "runtime"; identity: SlotIdentity };

/** Fencing waits only for earlier sends, never their response headers or streams. */
export class FleetDispatches {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Set<Promise<void>>>();

  private serialize<T>(work: () => Promise<T>) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  acquire<T extends Reservation>(work: () => Promise<T>) {
    return this.serialize(async () => {
      const reservation = await work();
      if (reservation.kind === "primary") return { reservation, dispatched: () => {} };
      const key = executionKey(reservation.identity);
      const pending = this.pending.get(key) ?? new Set<Promise<void>>();
      let finish!: () => void;
      const sent = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(sent);
      this.pending.set(key, pending);
      return {
        reservation,
        dispatched: () => {
          if (!pending.delete(sent)) return;
          if (pending.size === 0) this.pending.delete(key);
          finish();
        },
      };
    });
  }

  async fence(identity: SlotIdentity, work: () => Promise<unknown>) {
    const earlier = await this.serialize(async () => {
      await work();
      return [...(this.pending.get(executionKey(identity)) ?? [])];
    });
    await Promise.all(earlier);
  }
}
