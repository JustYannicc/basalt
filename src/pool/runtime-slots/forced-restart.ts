import { runtimeFailureDiagnostic } from "../runtime-route-diagnostic.ts";
import { sameIdentity, type SlotIdentity } from "./contract.ts";
import type { AdmissionProof, StartupWitness } from "./admission-proof.ts";
import type { RuntimeSlotStorage } from "./storage.ts";
import type { BoundSlotDriver } from "./transport.ts";
import { UnservingClock, unservingDecision, type UnservingState } from "./unserving-clock.ts";

// A running runtime refusing with one of these is not serving. Fence, selection, policy and
// draining refusals are deliberate states a forced restart must never fight.
const notServing = new Set([
  "unhealthy",
  "timeout",
  "transport",
  "slot_identity",
  "slot_unhealthy",
  "slot_uncertain",
]);

interface Witnessed {
  authorization: AdmissionProof;
  identity?: SlotIdentity;
  witness?: StartupWitness;
  running: boolean;
}
interface Pass {
  previous: SlotIdentity;
  epoch: number;
  digest: string;
  refusal: unknown;
  retained: Witnessed;
}

/**
 * Whether the container now running still belongs to the selected boot. A restart admitted over a
 * running container leaves a record with neither identity nor boot; once that restart has started
 * its own boot, the running container is the new boot, and stopping it would undo the restart.
 */
export function holdsSelectedBoot(record: Omit<Witnessed, "running">, previous: SlotIdentity) {
  return (
    sameIdentity(record.identity, previous) ||
    (record.authorization.kind === "restart" &&
      sameIdentity(record.authorization.previous, previous) &&
      !record.identity &&
      !record.witness?.bootId)
  );
}

/**
 * The controller's half of a forced restart: when to ask for the stop, and what it records. It also
 * ends a restart recovery started on its own that never serves in needs-a-person.
 */
export class RuntimeForcedRestart {
  readonly clock: UnservingClock;
  private storage: RuntimeSlotStorage;
  private driver: BoundSlotDriver;
  private declined?: string;
  constructor(storage: RuntimeSlotStorage, driver: BoundSlotDriver) {
    this.storage = storage;
    this.driver = driver;
    this.clock = new UnservingClock(storage);
  }
  /** One recovery pass, after its warm refused: returns true once the container was stopped. */
  async consider(pass: Pass, signal: AbortSignal) {
    const reason = runtimeFailureDiagnostic(pass.refusal, "slot_health").runtimeReason;
    // A single `running: false` read proves nothing, so it neither stops nor restarts the bound.
    if (!pass.retained.running) return false;
    if (!notServing.has(reason) || !holdsSelectedBoot(pass.retained, pass.previous)) {
      // The bound counts only an unbroken stretch of a running, refusing selected boot.
      this.declined = undefined;
      await this.clock.notRefusing();
      return false;
    }
    const now = Date.now();
    const state = await this.clock.refusing(pass.previous, now);
    // A forced restart that hasn't served yet is never stopped again: whatever runs is its own
    // start, slow or stuck, and its budget ends it in needs-a-person.
    if (state.restartedAt !== undefined) return false;
    const decision = unservingDecision(state, now);
    if (decision === "restart_limit") this.report(await this.clock.needsPerson(decision, now), now);
    if (decision !== "stop") return false;
    // A fence, candidate or policy edit committed since the pass began must win over the stop.
    const unchanged = await this.storage.transact(async (latest) => {
      const selection = latest.selection;
      return (
        selection?.epoch === pass.epoch &&
        sameIdentity(selection.active.identity, pass.previous) &&
        latest.digest === pass.digest &&
        !selection.active.fenced &&
        !selection.active.retirement &&
        !selection.candidate &&
        !selection.draining
      );
    });
    if (!unchanged) return false;
    let result: Awaited<ReturnType<BoundSlotDriver["stopRefusing"]>>;
    try {
      result = await this.driver.stopRefusing(pass.previous, state.since ?? now, signal);
    } catch (error) {
      // The endpoint declined for now (a refresh in flight, it answers health, or the container
      // isn't the selected boot's yet), or the call didn't land. A later pass asks again.
      const declined = runtimeFailureDiagnostic(error, "slot_health").runtimeReason;
      if (declined !== this.declined)
        console.info("POOL_SELECTED_RECOVERY", {
          phase: "stop_declined",
          at: now,
          slot: pass.previous.slotId,
          refusal: reason,
          declined,
        });
      this.declined = declined;
      if (state.streams) await this.clock.notWaiting();
      return false;
    }
    this.declined = undefined;
    if (!result.waiting && state.streams) await this.clock.notWaiting();
    if (result.waiting) {
      const before = state.streams;
      await this.clock.waitingFor(result.waiting);
      if (
        before?.active !== result.waiting.active ||
        before.stillSince !== result.waiting.stillSince
      )
        console.info("POOL_SELECTED_RECOVERY", {
          phase: "waiting_for_streams",
          at: now,
          slot: pass.previous.slotId,
          activeStreams: result.waiting.active,
          stillSince: result.waiting.stillSince,
        });
      return false;
    }
    if (result.limited) this.report(await this.clock.needsPerson("restart_limit", now), now);
    else if (!result.stopped) this.report(await this.clock.needsPerson("stop_failed", now), now);
    if (!result.stopped) return false;
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "stopped",
      at: now,
      slot: pass.previous.slotId,
      refusal: reason,
      hard: result.hard,
    });
    await this.clock.restarted(now);
    return true;
  }
  /** Any refusal: a restart, forced or not, that still hasn't served in its budget has failed. */
  async refused() {
    const now = Date.now();
    this.report(await this.clock.failedSince(now), now);
  }
  private report(state: UnservingState, now: number) {
    if (state.needsPerson?.at === now)
      console.error("POOL_SELECTED_RECOVERY_NEEDS_PERSON", JSON.stringify(state.needsPerson));
  }
}
