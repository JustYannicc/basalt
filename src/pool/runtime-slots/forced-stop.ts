import { Schema } from "effect";
import { SlotRefused, sameIdentity, type SlotIdentity } from "./contract.ts";
import { markStopSent } from "./container-end.ts";
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
  /**
   * Whether Home is mid token refresh. Images with carry 0695 report `refresh_in_flight` on
   * readiness; the Worker doesn't read it yet.
   */
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
    await markStopSent(ctx);
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
      await signalStop(container);
      // The stopped container is restarted in place, so a clean exit is left as it is.
      if (!container.running) return "graceful_exit";
      await container.destroy();
      return "destroy_after_grace";
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

const isProcessExit = Schema.is(Schema.Struct({ exitCode: Schema.Int }));

/**
 * SIGTERM, then the container's own exit or the grace. Home drains its claimed token refreshes on
 * SIGTERM, and whichever Home holds the master lease holds them all; a bare destroy can lose a token
 * a vendor just rotated. `monitor()` rejecting without an exit code isn't an exit, so the wait keeps
 * to the grace. `signalled` runs once SIGTERM is sent.
 */
async function signalStop(
  container: NonNullable<ControllerState["container"]>,
  signalled: () => void = () => {},
) {
  if (!container.running || !container.signal) return signalled();
  container.signal(15);
  signalled();
  const grace = runtimeStopTiming.stopGrace();
  const exit = container.monitor().then(
    () => "exit" as const,
    (error: unknown) => (error instanceof Error && isProcessExit(error) ? "exit" : "unknown"),
  );
  if ((await Promise.race([exit, grace.then(() => "grace" as const)])) === "unknown") await grace;
}

/**
 * A deliberate end of a running container that never runs again: the graceful stop, then
 * `destroy()` only if it still runs. An exited instance is listed inactive about 10 s after its exit
 * code 0 or 137 alike, as a destroyed one is, and `destroy()` after an exit changes nothing. A
 * container without `signal()` can only be destroyed.
 */
export async function stopGracefully(
  container: NonNullable<ControllerState["container"]>,
  signalled?: () => void,
) {
  await signalStop(container, signalled);
  if (!container.running) return "exited" as const;
  await container.destroy();
  return "destroyed" as const;
}
