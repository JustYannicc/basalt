import { Schema } from "effect";
import { SlotRefused, executionKey, sameIdentity, type SlotIdentity } from "./contract.ts";
import type { RuntimeWitnessStore, WitnessRecord } from "./witness-store.ts";
import type { RuntimeActivity } from "./activity.ts";
import type { ControllerState } from "./runtime-state.ts";
import type { RuntimeConfiguration } from "./configuration.ts";
import { poolLifecycle, type PoolStatus } from "../lifecycle.ts";

const stopsKey = "runtime-endpoint-v1:forced-stops";
const Stops = Schema.Array(Schema.Number);
/** At most this many forced stops per container object in any hour, whatever the controller asks. */
export const forcedStopsPerHour = 3;
const hourMs = 3_600_000;
/** A slow runtime that still answers within this is serving, and is never stopped. */
export const servingReadMs = 10_000;
/** Streams counted active only stop a forced stop until their count has stood still this long. */
export const leakedStreamsMs = 300_000;
/**
 * A restart's own start answers readiness, or meets its startup deadline, well within this of its
 * admission. Past it, a container under that restart that doesn't answer is not its start.
 */
export const restartStartBoundMs = poolLifecycle.startupTimeoutMs + 60_000;

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
/**
 * After SIGTERM the supervisor gives its children 15 s, then kills them and waits 1 s
 * (`terminate_children` in containers/pool/supervisor.py). A test keeps the two in step.
 */
export const supervisorStopGraceMs = 16_000;
/** Longer than the supervisor's grace, so a Home finishing a token write-back is never cut short. */
export const forcedStopGraceMs = 30_000;
/** The waits around stopping a container; tests replace them instead of sleeping. */
export const runtimeStopTiming = {
  /** Between the two "not running" reads that admit a restart. */
  confirmExit: () => pause(2_000),
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
  private streams?: { boot: string; active: number; since: number };
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async stop(identity: SlotIdentity, force: boolean, signal: AbortSignal) {
    const { ctx, store } = this.deps;
    const { record, configuration } = await store.read(identity);
    const container = ctx.container!;
    if (!(await this.ownsRunningBoot(record, configuration, identity, signal)))
      throw new SlotRefused("identity");
    if (!container.running) return { stopped: true, hard: false };
    if (await this.serving(identity, signal)) throw new SlotRefused("selection");
    const active = await this.blockingStreams(identity, force);
    if (active === undefined) throw new SlotRefused("draining");
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
      JSON.stringify({ slot: identity.slotId, path, activeStreams: active, forced: force }),
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
  /** Active streams that may block the stop, or undefined while they still do. */
  private async blockingStreams(identity: SlotIdentity, force: boolean) {
    const active = (await this.deps.activity.inspect(identity))?.active ?? 0;
    const boot = executionKey(identity);
    const now = Date.now();
    if (active === 0) {
      this.streams = undefined;
      return 0;
    }
    if (this.streams?.boot !== boot || this.streams.active !== active)
      this.streams = { boot, active, since: now };
    // Live traffic moves the count; a count that has stood still this long is leaked.
    return force && now - this.streams.since >= leakedStreamsMs ? active : undefined;
  }
  private async signal(container: NonNullable<ControllerState["container"]>): Promise<StopPath> {
    // Without SIGTERM the single root's Home, the elected master, would be killed mid-refresh.
    if (!container.signal) return "no_signal";
    try {
      container.signal(15);
      await Promise.race([container.monitor().catch(() => {}), runtimeStopTiming.stopGrace()]);
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
