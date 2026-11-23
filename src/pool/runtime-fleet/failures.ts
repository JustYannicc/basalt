import { executionKey, type SlotIdentity } from "../runtime-slots/contract.ts";
import { FleetRefused, type QuarantineReason, type RuntimeFleetState } from "./state.ts";
import {
  failureIgnored,
  failureMismatch,
  failureRead,
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
  private blocked = new Set<string>();
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
    if (this.blocked.has(executionKey(identity))) throw new FleetFenced();
  }
  fenced(identity: SlotIdentity) {
    return this.blocked.has(executionKey(identity));
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
    return this.quarantine(identity, "runtime_failed", { path, reads: [read] });
  }
  /**
   * A failed health read is one sample of what may be a transient. It fences the runtime here at
   * once and in the durable row, so no new call reaches it; the next pass reads it again. A second
   * failed read in a row, or a read that reached another process, quarantines it.
   */
  async missed(identity: SlotIdentity, read: FleetFailureRead) {
    if (failureIgnored(read)) return "ignored" as const;
    if (failureMismatch(read)) {
      await this.quarantine(identity, "runtime_failed", { path: "health", reads: [read] });
      return "quarantined" as const;
    }
    const key = executionKey(identity);
    this.blocked.add(key);
    const outcome = await this.state.miss(identity, read);
    if (outcome === "quarantined") this.changed();
    // A row that no longer serves takes no call anyway; its durable phase governs from here.
    if (outcome === "gone") this.blocked.delete(key);
    return outcome;
  }
  /** A good read after a miss: the runtime takes calls again, unless a failure quarantines it. */
  async recovered(identity: SlotIdentity) {
    const key = executionKey(identity);
    if (this.pending.has(key)) return;
    if ((await this.state.clearMiss(identity)) && !this.pending.has(key)) this.blocked.delete(key);
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
