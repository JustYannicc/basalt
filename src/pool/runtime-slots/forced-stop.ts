import { Schema } from "effect";
import { SlotRefused, sameIdentity, type SlotIdentity } from "./contract.ts";
import type { RuntimeWitnessStore } from "./witness-store.ts";
import type { RuntimeActivity } from "./activity.ts";
import type { ControllerState } from "./runtime-state.ts";

const stopsKey = "runtime-endpoint-v1:forced-stops";
const Stops = Schema.Array(Schema.Number);
/** At most this many forced stops per container object in any hour, whatever the controller asks. */
export const forcedStopsPerHour = 3;
const hourMs = 3_600_000;

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
/** The waits around stopping a container; tests replace them instead of sleeping. */
export const runtimeStopTiming = {
  /** Between the two "not running" reads that admit a restart. */
  confirmExit: () => pause(2_000),
  /** How long SIGTERM gets before `destroy()`. */
  stopGrace: () => pause(30_000),
  /** Whether Home is mid token refresh. The image doesn't report it yet; the Home owner adds it. */
  refreshInFlight: async (): Promise<boolean> => false,
};
interface Dependencies {
  ctx: ControllerState;
  store: RuntimeWitnessStore;
  activity: RuntimeActivity;
  /** The endpoint's own health read; a runtime that answers it is serving and is never stopped. */
  health(identity: SlotIdentity, signal: AbortSignal): Promise<unknown>;
}

/**
 * Stops a running container that keeps refusing, so the existing stopped-container restart can
 * replace it. The container's own object owns the stop: SIGTERM first, `destroy()` only after the
 * grace. The stop is counted before the signal, so a repeated alarm never signals twice uncounted.
 */
export class RuntimeForcedStop {
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async stop(identity: SlotIdentity, force: boolean, signal: AbortSignal) {
    const { ctx, store, activity } = this.deps;
    const { record } = await store.read(identity);
    // A restart admitted over this boot (19 Nov 2026) dropped the record's identity; it still owns it.
    const owned =
      sameIdentity(record.identity, identity) ||
      (record.authorization.kind === "restart" &&
        sameIdentity(record.authorization.previous, identity));
    if (!owned) throw new SlotRefused("identity");
    const container = ctx.container!;
    if (!container.running) return { stopped: true, hard: false };
    if (await this.serving(identity, signal)) throw new SlotRefused("selection");
    const active = (await activity.inspect(identity))?.active ?? 0;
    if (active > 0 && !force) throw new SlotRefused("draining");
    if (await runtimeStopTiming.refreshInFlight()) throw new SlotRefused("draining");
    const now = Date.now();
    const recent = Schema.decodeUnknownSync(Stops)((await ctx.storage.get(stopsKey)) ?? []).filter(
      (at) => at > now - hourMs,
    );
    if (recent.length >= forcedStopsPerHour) throw new SlotRefused("uncertain");
    await ctx.storage.put(stopsKey, [...recent, now]);
    let hard = false;
    if (container.signal) {
      container.signal(15);
      await Promise.race([container.monitor().catch(() => {}), runtimeStopTiming.stopGrace()]);
    }
    if (container.running) {
      hard = true;
      await container.destroy();
    }
    console.error(
      "POOL_RUNTIME_FORCED_STOP",
      JSON.stringify({ slot: identity.slotId, hard, activeStreams: active, forced: force }),
    );
    return { stopped: !container.running, hard };
  }
  private async serving(identity: SlotIdentity, signal: AbortSignal) {
    try {
      await this.deps.health(identity, AbortSignal.any([signal, AbortSignal.timeout(2_000)]));
      return true;
    } catch {
      return false;
    }
  }
}
