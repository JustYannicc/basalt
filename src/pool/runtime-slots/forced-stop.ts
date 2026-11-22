import { Schema } from "effect";
import { SlotRefused, sameIdentity, type SlotIdentity } from "./contract.ts";
import type { RuntimeWitnessStore, WitnessRecord } from "./witness-store.ts";
import type { RuntimeActivity } from "./activity.ts";
import type { ControllerState } from "./runtime-state.ts";
import type { RuntimeConfiguration } from "./configuration.ts";
import type { PoolStatus } from "../lifecycle.ts";
import {
  exitConfirmationMs,
  forcedStopGraceMs,
  forcedStopsPerHour,
  leakedStreamsMs,
  restartStartBoundMs,
  servingReadMs,
} from "./forced-restart-timing.ts";

const stopsKey = "runtime-endpoint-v1:forced-stops";
const Stops = Schema.Array(Schema.Number);
const hourMs = 3_600_000;
const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
/** The waits around stopping a container; tests replace them instead of sleeping. */
export const runtimeStopTiming = {
  /** Between the two "not running" reads that admit a restart. */
  confirmExit: () => pause(exitConfirmationMs),
  /** How long SIGTERM gets before `destroy()`. */
  stopGrace: () => pause(forcedStopGraceMs),
  /** Whether Home is mid token refresh. The image doesn't report it yet; the Home owner adds it. */
  refreshInFlight: async (): Promise<boolean> => false,
};
type StopPath = "graceful_exit" | "destroy_after_grace" | "no_signal" | "stop_failed";
interface Dependencies {
  ctx: ControllerState;
  store: RuntimeWitnessStore;
  activity: RuntimeActivity;
  /** The endpoint's own health read; a runtime that answers it is serving and is never stopped. */
  health(identity: SlotIdentity, signal: AbortSignal): Promise<unknown>;
  /** The container's readiness answer, whoever's boot it is. */
  readiness(configuration: RuntimeConfiguration, signal: AbortSignal): Promise<PoolStatus>;
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
  /** `refusingSince`: when the controller first saw this boot refuse while running. */
  async stop(identity: SlotIdentity, refusingSince: number, signal: AbortSignal) {
    const { ctx, store } = this.deps;
    const { record, configuration } = await store.read(identity);
    const container = ctx.container!;
    if (!(await this.ownsRunningBoot(record, configuration, identity, signal)))
      throw new SlotRefused("identity");
    if (!container.running) return { stopped: true, hard: false };
    if (await this.serving(identity, signal)) throw new SlotRefused("selection");
    const held = await this.heldBy(identity, refusingSince);
    if (held && Date.now() - held.stillSince < leakedStreamsMs)
      return { stopped: false, hard: false, waiting: held };
    if (await runtimeStopTiming.refreshInFlight()) throw new SlotRefused("draining");
    const now = Date.now();
    const recent = Schema.decodeUnknownSync(Stops)((await ctx.storage.get(stopsKey)) ?? []).filter(
      (at) => at > now - hourMs,
    );
    if (recent.length >= forcedStopsPerHour) return { stopped: false, hard: false, limited: true };
    await ctx.storage.put(stopsKey, [...recent, now]);
    const path = await this.signal(container);
    console.error(
      "POOL_RUNTIME_FORCED_STOP",
      JSON.stringify({ slot: identity.slotId, path, activeStreams: held?.active ?? 0 }),
    );
    return { stopped: !container.running, hard: path !== "graceful_exit" };
  }
  /**
   * The running container is the selected boot's: the record names it, or a restart admitted over it
   * left no identity, and the container isn't that restart's start. A container answers readiness
   * only with the launch it was started with, so another launch, or none, is the old container. One
   * that doesn't answer is the restart's own start only while that start can still be in progress.
   */
  private async ownsRunningBoot(
    record: WitnessRecord,
    configuration: RuntimeConfiguration,
    identity: SlotIdentity,
    signal: AbortSignal,
  ) {
    if (sameIdentity(record.identity, identity)) return true;
    const authorization = record.authorization;
    if (
      authorization.kind !== "restart" ||
      !sameIdentity(authorization.previous, identity) ||
      record.identity ||
      record.witness?.bootId
    )
      return false;
    const launch = record.witness?.launch;
    if (!launch || !this.deps.ctx.container!.running) return true;
    try {
      const status = await this.deps.readiness(
        configuration,
        AbortSignal.any([signal, AbortSignal.timeout(servingReadMs)]),
      );
      return (
        status.launch?.generation !== launch.generation ||
        status.launch.tokenHash !== launch.tokenHash
      );
    } catch {
      return Date.now() - authorization.at > restartStartBoundMs;
    }
  }
  /** The streams counted active on this boot and since when their count has stood still. */
  private async heldBy(identity: SlotIdentity, refusingSince: number) {
    const row = await this.deps.activity.inspect(identity);
    if (!row?.active) return undefined;
    // This code stamps every acquire and release, so an unstamped count has stood still at least
    // since the controller, running this code, first saw the boot refuse.
    return { active: row.active, stillSince: row.changedAt ?? refusingSince };
  }
  private async signal(container: NonNullable<ControllerState["container"]>): Promise<StopPath> {
    // Without SIGTERM the single root's Home, the elected master, would be killed mid-refresh.
    if (!container.signal) return "no_signal";
    try {
      return (await stopGracefully(container)) === "exited"
        ? "graceful_exit"
        : "destroy_after_grace";
    } catch {
      return "stop_failed";
    }
  }
  private async serving(identity: SlotIdentity, signal: AbortSignal) {
    try {
      await this.deps.health(
        identity,
        AbortSignal.any([signal, AbortSignal.timeout(servingReadMs)]),
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Every deliberate end of a running container: SIGTERM, then its own exit or the grace, and
 * `destroy()` only if it still runs. Home drains its claimed token refreshes on SIGTERM, and whichever
 * Home holds the master lease holds them all; a bare destroy can lose a token a vendor just rotated.
 * A container without `signal()` can only be destroyed.
 */
export async function stopGracefully(container: NonNullable<ControllerState["container"]>) {
  if (container.running && container.signal) {
    container.signal(15);
    await Promise.race([container.monitor().catch(() => {}), runtimeStopTiming.stopGrace()]);
  }
  if (!container.running) return "exited" as const;
  await container.destroy();
  return "destroyed" as const;
}
