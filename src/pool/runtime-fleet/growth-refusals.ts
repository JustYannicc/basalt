import { errorClass, providerFields } from "../pending-failure.ts";
import { runtimeFailureCause, runtimeRouteDiagnostic } from "../runtime-route-diagnostic.ts";
import { SlotRefused } from "../runtime-slots/contract.ts";
import { FleetRefused, type FleetRow } from "./state.ts";

/** A refusal episode still refused this long logs once more: its retries are otherwise silent. */
export const stillRefusedMs = 30_000;

/**
 * Why growth was refused, as closed values only, never message text: the runtime's step, reason
 * and cause when the error carries them, a local refusal's own reason, and the error's class. A
 * provider refusal adds the read it refused and its own reason, with any status, pin or state.
 */
function growthRefusal(error: unknown) {
  const diagnostic = runtimeRouteDiagnostic(error);
  return {
    step: diagnostic?.runtimeStep ?? null,
    reason:
      diagnostic?.runtimeReason ??
      (error instanceof SlotRefused || error instanceof FleetRefused ? error.reason : null),
    cause: runtimeFailureCause(error) ?? null,
    error: error instanceof FleetRefused ? "FleetRefused" : errorClass(error),
    ...providerFields(error),
  };
}
type Refusal = ReturnType<typeof growthRefusal>;
interface Episode {
  since: number;
  attempts: number;
  latest: Refusal;
  still: boolean;
}

/**
 * What growth's refusals say. A refusal logs when any of its fields changes. Each slot whose start
 * fails has its own episode, counting every failed try of that start, growth's first and upkeep's
 * retries, a refusal or a start that doesn't answer yet: once it has lasted `stillRefusedMs` it logs once more, and that slot's
 * admission logs how long it lasted and how many tries were refused. An episode whose slot leaves
 * unadmitted ends without a line. Episodes live in memory, so a replaced isolate opens a fresh one
 * at the start's next refused try.
 */
export class GrowthRefusals {
  private now: () => number;
  private logged?: string;
  private episodes = new Map<string, Episode>();
  constructor(now: () => number) {
    this.now = now;
  }
  /** Growth retries on every request and alarm, so only a changed refusal logs. */
  refused(error: unknown) {
    const refusal = growthRefusal(error);
    const key = JSON.stringify(refusal);
    // A rollout right after a cell image change is expected; every other refusal warns.
    if (key !== this.logged)
      (refusal.reason === "rollout_active" ? console.info : console.warn)(
        "POOL_FLEET_GROWTH_REFUSED",
        refusal,
      );
    this.logged = key;
  }
  /** A refused try of this slot's start opens or extends its episode, with no line of its own. */
  startRefused(slot: string, error: unknown) {
    const now = this.now();
    const refusal = growthRefusal(error);
    const episode = this.episodes.get(slot) ?? {
      since: now,
      attempts: 0,
      latest: refusal,
      still: false,
    };
    this.episodes.set(slot, episode);
    episode.attempts++;
    episode.latest = refusal;
    if (episode.still || now - episode.since < stillRefusedMs) return;
    episode.still = true;
    // A start held by an announced image rollout is the designed state, and warn lines count as
    // findings, so it logs at info. Any other reason held this long holds scale-out, and warns.
    (episode.latest.reason === "rollout_active" ? console.info : console.warn)(
      "POOL_FLEET_GROWTH_STILL_REFUSED",
      this.summary(episode),
    );
  }
  /** A pass that ended unrefused, so the same refusal logs again. */
  passed() {
    this.logged = undefined;
  }
  started(slot: string) {
    this.logged = undefined;
    const episode = this.episodes.get(slot);
    if (!episode) return;
    this.episodes.delete(slot);
    console.info("POOL_FLEET_GROWTH_RECOVERED", this.summary(episode));
  }
  /**
   * Ends, with no line, each episode whose slot no longer starts: given up, quarantined, gone.
   * Slot ids are never reused, so this only bounds the map, to the starts the fleet can hold.
   */
  settle(rows: readonly FleetRow[]) {
    const starting = new Set(
      rows
        .filter((row) => ["reserved", "warming", "uncertain"].includes(row.phase))
        .map((row) => row.target.slotId),
    );
    for (const slot of this.episodes.keys()) if (!starting.has(slot)) this.episodes.delete(slot);
  }
  /** The episode so far, named by its latest failed try: what was still in the way. */
  private summary(episode: Episode) {
    const { latest } = episode;
    return {
      refusedMs: this.now() - episode.since,
      attempts: episode.attempts,
      // A start that doesn't answer yet has no reason, only its error's class, step and cause.
      error: latest.error,
      step: latest.step,
      cause: latest.cause,
      read: latest.read ?? null,
      reason: latest.reason,
      ...(latest.status === undefined ? {} : { status: latest.status }),
      ...(latest.field === undefined ? {} : { field: latest.field }),
      ...(latest.state === undefined ? {} : { state: latest.state }),
    };
  }
}
