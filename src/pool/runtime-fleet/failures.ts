import { executionKey, type SlotIdentity } from "../runtime-slots/contract.ts";
import { FleetRefused, type QuarantineReason, type RuntimeFleetState } from "./state.ts";
import {
  failureBeforeSend,
  failureIgnored,
  failureMismatch,
  failureRead,
  nextSuspect,
  policyInstalled,
  readSuspect,
  unprovenMs,
  type FleetFailure,
  type FleetFailureRead,
} from "./failure-record.ts";

/** This controller's own fence refused the call: it says nothing about the runtime. */
export class FleetFenced extends FleetRefused {
  constructor() {
    super("uncertain");
  }
}

/** Failure fencing denies unsent calls locally before committing the durable selection fence. */
export class FleetFailures {
  // Quarantines, final for this isolate, and failed health reads, which a good read clears.
  private blocked = new Set<string>();
  private suspect = new Set<string>();
  // When each runtime's latest read that was not good was taken, so a good read that began
  // earlier never lifts its fence, even when that read's own durable write was rolled back.
  private lastMiss = new Map<string, number>();
  // When each fence began, kept here too: its durable record may not be written.
  private firstMiss = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  private state: RuntimeFleetState;
  private changed: () => void;
  private now: () => number;
  constructor(state: RuntimeFleetState, changed: () => void, now: () => number = Date.now) {
    this.state = state;
    this.changed = changed;
    this.now = now;
  }
  assertAvailable(identity: SlotIdentity) {
    if (this.fenced(identity)) throw new FleetFenced();
  }
  fenced(identity: SlotIdentity) {
    const key = executionKey(identity);
    return this.blocked.has(key) || this.suspect.has(key);
  }
  /** Quarantined here, even while its durable write is still pending: it never serves again. */
  quarantined(identity: SlotIdentity) {
    return this.blocked.has(executionKey(identity));
  }
  /** When this isolate first fenced the runtime on a read that was not good, while it still does. */
  fencedSince(identity: SlotIdentity) {
    return this.firstMiss.get(executionKey(identity));
  }
  private unfence(key: string) {
    this.suspect.delete(key);
    this.lastMiss.delete(key);
    this.firstMiss.delete(key);
  }
  /** A real request failed on the runtime, before or during its answer: evidence, so it quarantines. */
  async failed(
    identity: SlotIdentity,
    error: unknown,
    signal: AbortSignal,
    path: "forward" | "stream",
  ) {
    if (signal.aborted || error instanceof FleetFenced) return;
    const read = failureRead(error, "fleet_forward", this.now());
    if (failureIgnored(read)) return;
    if (failureBeforeSend(read)) {
      await this.missed(identity, read);
      return;
    }
    return this.quarantine(identity, "runtime_failed", { path, rule: "evidence", reads: [read] });
  }
  /**
   * A health read that was not good is one sample of what may be a transient. It fences the runtime
   * here at once and in the durable row, so no new call reaches it, and `nextSuspect` decides the
   * rest; a read that reached another process quarantines it at once.
   */
  async missed(
    identity: SlotIdentity,
    read: FleetFailureRead,
    options: { path?: "health" | "install"; owe?: { pool: string; revision: number } } = {},
  ) {
    if (failureIgnored(read)) return "ignored" as const;
    if (failureMismatch(read)) {
      await this.quarantine(identity, "runtime_failed", {
        path: options.path ?? "health",
        rule: "evidence",
        reads: [read],
      });
      return "quarantined" as const;
    }
    const key = executionKey(identity);
    const wasSuspect = this.suspect.has(key);
    this.suspect.add(key);
    if (!this.firstMiss.has(key)) this.firstMiss.set(key, read.at);
    this.lastMiss.set(key, Math.max(read.at, this.lastMiss.get(key) ?? read.at));
    const outcome = await this.state.suspect(identity, (current) =>
      nextSuspect(readSuspect(current), read, options),
    );
    if (outcome === "quarantined") {
      this.blocked.add(key);
      this.unfence(key);
      this.changed();
    }
    // A row that no longer serves takes no call anyway; its durable phase governs from here.
    // A fence held before this read stays until a good read lifts it.
    if (outcome === "gone" && !wasSuspect && !this.pending.has(key)) {
      this.suspect.delete(key);
      this.firstMiss.delete(key);
    }
    return outcome;
  }
  /**
   * A good read that began at `readAt` lifts only a suspect's own fence, never a quarantine's, and
   * never one a later read set.
   */
  async recovered(identity: SlotIdentity, readAt: number, snapshot?: unknown) {
    const key = executionKey(identity);
    const newer = () => (this.lastMiss.get(key) ?? -Infinity) >= readAt;
    if (this.pending.has(key) || newer()) return;
    const cleared = await this.state.clearSuspect(identity, (current) => {
      const suspect = readSuspect(current);
      const last = suspect?.reads.at(-1)?.at;
      // A cell still owing a pool's current policy serves again only once that policy is installed.
      return (last === undefined || last < readAt) && !suspect?.policyOwed?.length;
    });
    if (cleared && !this.pending.has(key) && !newer()) {
      this.unfence(key);
      return;
    }
    // Good reads but no install that lands: the same 30 s bound as any other proof that never comes.
    const owing = readSuspect(snapshot);
    if (!owing?.policyOwed?.length || readAt - owing.since < unprovenMs) return;
    const outcome = await this.state.suspect(identity, (current) => {
      const suspect = readSuspect(current);
      return suspect?.policyOwed?.length && readAt - suspect.since >= unprovenMs
        ? { quarantine: { path: "install", rule: "unproven", reads: suspect.reads } }
        : { unchanged: true };
    });
    if (outcome === "quarantined") {
      this.blocked.add(key);
      this.unfence(key);
      this.changed();
    }
  }
  /** An install of `revision` for `pool` reached the cell: it no longer owes that or older. */
  async installed(identity: SlotIdentity, pool: string, revision: number) {
    await this.state.suspect(identity, (current) => {
      const suspect = readSuspect(current);
      const next = suspect && policyInstalled(suspect, pool, revision);
      return next ? { suspect: next } : { unchanged: true };
    });
  }
  /** A runtime that refused a membership policy takes no new call under its old one. */
  refused(identity: SlotIdentity) {
    return this.quarantine(identity, "policy_refused");
  }
  private async quarantine(
    identity: SlotIdentity,
    reason: QuarantineReason,
    failure?: FleetFailure,
  ) {
    const key = executionKey(identity);
    this.blocked.add(key);
    const retained = this.pending.get(key);
    if (retained) return retained;
    const work = this.state.quarantine(identity, reason, failure).finally(() => this.changed());
    this.pending.set(key, work);
    try {
      await work;
    } finally {
      this.pending.delete(key);
    }
  }
}
