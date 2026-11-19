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

/** The controller's half of a forced restart: when to ask for the stop, and what it records. */
export class RuntimeForcedRestart {
  readonly clock: UnservingClock;
  private storage: RuntimeSlotStorage;
  private driver: BoundSlotDriver;
  constructor(storage: RuntimeSlotStorage, driver: BoundSlotDriver) {
    this.storage = storage;
    this.driver = driver;
    this.clock = new UnservingClock(storage);
  }
  /** One recovery pass, after its warm refused: returns true once the container was stopped. */
  async consider(pass: Pass, signal: AbortSignal) {
    const reason = runtimeFailureDiagnostic(pass.refusal, "slot_health").runtimeReason;
    if (
      !pass.retained.running ||
      !notServing.has(reason) ||
      !holdsSelectedBoot(pass.retained, pass.previous)
    ) {
      // The bound counts only an unbroken stretch of a running, refusing selected boot.
      await this.clock.notRefusing();
      return false;
    }
    const now = Date.now();
    const state = await this.clock.refusing(pass.previous, now);
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
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "stopping",
      at: now,
      slot: pass.previous.slotId,
      refusal: reason,
    });
    let result: Awaited<ReturnType<BoundSlotDriver["stopRefusing"]>>;
    try {
      result = await this.driver.stopRefusing(pass.previous, state.since ?? now, signal);
    } catch {
      // The endpoint declined for now (streams, a refresh in flight, or it answers health), or
      // the call didn't land; a later pass asks again, and nothing here marks it failed.
      return false;
    }
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
    await this.clock.restarted(now);
    return true;
  }
  /** Any refusal: a forced restart that still hasn't served in its budget has failed. */
  async refused() {
    const now = Date.now();
    this.report(await this.clock.failedSince(now), now);
  }
  private report(state: UnservingState, now: number) {
    if (state.needsPerson?.at === now)
      console.error("POOL_SELECTED_RECOVERY_NEEDS_PERSON", JSON.stringify(state.needsPerson));
  }
}
