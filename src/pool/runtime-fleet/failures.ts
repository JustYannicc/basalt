import { executionKey, type SlotIdentity } from "../runtime-slots/contract.ts";
import { runtimeFailureDiagnostic } from "../runtime-route-diagnostic.ts";
import { FleetRefused, type RuntimeFleetState } from "./state.ts";

/** Failure fencing denies unsent calls locally before committing the durable selection fence. */
export class FleetFailures {
  private blocked = new Set<string>();
  private pending = new Map<string, Promise<void>>();
  private state: RuntimeFleetState;
  private changed: () => void;
  constructor(state: RuntimeFleetState, changed: () => void) {
    this.state = state;
    this.changed = changed;
  }
  assertAvailable(identity: SlotIdentity) {
    if (this.blocked.has(executionKey(identity))) throw new FleetRefused("uncertain");
  }
  async failed(identity: SlotIdentity, error: unknown, signal: AbortSignal) {
    if (signal.aborted) return;
    const diagnostic = runtimeFailureDiagnostic(error, "fleet_forward");
    if (
      diagnostic.runtimeReason === "aborted" ||
      diagnostic.runtimeReason === "slot_policy" ||
      diagnostic.runtimeStep === "slot_authorize"
    )
      return;
    const key = executionKey(identity);
    this.blocked.add(key);
    const retained = this.pending.get(key);
    if (retained) return retained;
    const work = this.state.quarantine(identity).then(() => this.changed());
    this.pending.set(key, work);
    try {
      await work;
    } finally {
      this.pending.delete(key);
    }
  }
}
