import { executionKey, type SlotIdentity } from "../runtime-slots/contract.ts";
import { FleetRefused, type QuarantineReason, type RuntimeFleetState } from "./state.ts";
import {
  failureBeforeSend,
  failureIgnored,
  failureMismatch,
  failureRead,
  nextSuspect,
  readSuspect,
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
  async missed(identity: SlotIdentity, read: FleetFailureRead) {
    if (failureIgnored(read)) return "ignored" as const;
    if (failureMismatch(read)) {
      await this.quarantine(identity, "runtime_failed", {
        path: "health",
        rule: "evidence",
        reads: [read],
      });
      return "quarantined" as const;
    }
    const key = executionKey(identity);
    this.suspect.add(key);
    const outcome = await this.state.suspect(identity, (current) =>
      nextSuspect(readSuspect(current), read),
    );
    if (outcome === "quarantined") {
      this.blocked.add(key);
      this.suspect.delete(key);
      this.changed();
    }
    // A row that no longer serves takes no call anyway; its durable phase governs from here.
    if (outcome === "gone" && !this.pending.has(key)) this.suspect.delete(key);
    return outcome;
  }
  /** A good read lifts only a suspect's own fence; a quarantine's stays. */
  async recovered(identity: SlotIdentity) {
    const key = executionKey(identity);
    if (this.pending.has(key)) return;
    if ((await this.state.clearSuspect(identity)) && !this.pending.has(key))
      this.suspect.delete(key);
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
