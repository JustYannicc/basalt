import { errorClass, providerFields } from "../pending-failure.ts";
import { runtimeFailureCause, runtimeRouteDiagnostic } from "../runtime-route-diagnostic.ts";
import { SlotRefused } from "../runtime-slots/contract.ts";
import { FleetRefused } from "./state.ts";

/** A refusal episode still refused this long logs once more: its retries are otherwise silent. */
export const stillRefusedMs = 30_000;

/**
 * Why growth was refused, as closed values only, never message text: the runtime's step, reason
 * and cause when the error carries them, a local refusal's own reason, and the error's class. A
 * provider refusal adds the read it refused and its own reason, with any status, pin or state.
 */
export function growthRefusal(error: unknown) {
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

// A rollout right after a cell image change is expected; every other refusal warns.
const write = (line: string, refusal: Refusal, fields: object) =>
  (refusal.reason === "rollout_active" ? console.info : console.warn)(line, fields);

/**
 * What growth's refusals say. A refusal logs when any of its fields changes. An episode runs from
 * the first refusal to the next cell that starts, counting every refused try, growth's own and
 * the retries of its unsent start: once it has lasted `stillRefusedMs` it logs once more, and the
 * start that ends it logs how long it lasted and how many tries were refused.
 */
export class GrowthRefusals {
  private now: () => number;
  private logged?: string;
  private episode?: { since: number; attempts: number; latest: Refusal; still: boolean };
  constructor(now: () => number) {
    this.now = now;
  }
  /** Growth retries on every request and alarm, so only a changed refusal logs. */
  refused(error: unknown) {
    const refusal = growthRefusal(error);
    const key = JSON.stringify(refusal);
    if (key !== this.logged) write("POOL_FLEET_GROWTH_REFUSED", refusal, refusal);
    this.logged = key;
    this.count(refusal);
  }
  /** A retried start that was refused counts against an open episode and logs no line of its own. */
  retried(error: unknown) {
    if (this.episode) this.count(growthRefusal(error));
  }
  /** A pass that ended unrefused, so the same refusal logs again. */
  passed() {
    this.logged = undefined;
  }
  started() {
    this.logged = undefined;
    const episode = this.episode;
    if (!episode) return;
    this.episode = undefined;
    console.info("POOL_FLEET_GROWTH_RECOVERED", this.summary(episode));
  }
  private count(refusal: Refusal) {
    const now = this.now();
    const episode = (this.episode ??= { since: now, attempts: 0, latest: refusal, still: false });
    episode.attempts++;
    episode.latest = refusal;
    if (episode.still || now - episode.since < stillRefusedMs) return;
    episode.still = true;
    write("POOL_FLEET_GROWTH_STILL_REFUSED", refusal, this.summary(episode));
  }
  /** The episode so far, named by its latest refusal: what was still in the way. */
  private summary(episode: { since: number; attempts: number; latest: Refusal }) {
    const { latest } = episode;
    return {
      refusedMs: this.now() - episode.since,
      attempts: episode.attempts,
      read: latest.read ?? null,
      reason: latest.reason,
      ...(latest.status === undefined ? {} : { status: latest.status }),
      ...(latest.field === undefined ? {} : { field: latest.field }),
      ...(latest.state === undefined ? {} : { state: latest.state }),
    };
  }
}
