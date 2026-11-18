import { refuseRuntime, rememberRuntimeFailure } from "../runtime-route-diagnostic.ts";
import type { NativeStreamLease } from "../native-streams.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import {
  sameIdentity,
  sameTarget,
  type SlotIdentity,
  type SlotTarget,
} from "../runtime-slots/contract.ts";
import { FleetRefused, RuntimeFleetState } from "./state.ts";
import { FleetDispatches } from "./dispatches.ts";
import { PoolUpkeepTrace } from "../upkeep-trace.ts";
import { FleetFailures } from "./failures.ts";
import { distanceClass, type DistanceClass, type RuntimeDistance } from "../runtime-distance.ts";

/** A far cell is started again at most this many times before it serves from its last draw. */
export const placementDraws = 4;
type PlacementDecision = "admit" | "admit_unknown" | "admit_alone" | "admit_after_limit" | "redraw";

/** One closed line per admission decision, so where each runtime landed is visible. */
function logPlacement(
  identity: SlotIdentity,
  database: RuntimeDistance | undefined,
  decision: PlacementDecision,
  draw: number,
) {
  console.info("POOL_RUNTIME_PLACEMENT", {
    slot: identity.slotId,
    decision,
    draw,
    class: distanceClass(database),
    state: database?.state ?? null,
    location: database?.location ?? null,
    dbRttMs: database?.rttMs ?? null,
  });
}

export interface FleetCell {
  start(target: SlotTarget): Promise<SlotIdentity>;
  observe(target: SlotTarget, retryUnsent?: boolean): Promise<SlotIdentity | undefined>;
  selected(): Promise<SlotIdentity | undefined>;
  healthy?(identity: SlotIdentity): Promise<RuntimeDistance | undefined | void>;
  forward(
    request: Request,
    port: 8317,
    pool: string | undefined,
    beforeDispatch: () => void,
  ): Promise<Response>;
  install(policy: NativeMembershipPolicy): Promise<void>;
  abortPool(pool: string): void;
  drain(identity: SlotIdentity): Promise<{ active: number; known: boolean }>;
  retire(identity: SlotIdentity, begin: () => Promise<void>): Promise<void>;
  retired(identity: SlotIdentity, resumeBeforeDispatch?: boolean): Promise<boolean>;
  failed(identity: SlotIdentity, active: number): Promise<boolean>;
}
interface Dependencies {
  state: RuntimeFleetState;
  target(occupied: readonly SlotTarget[]): Promise<SlotTarget>;
  cell(target: SlotTarget): FleetCell;
  legacyActive(): Promise<number>;
  currentRequests(): number;
  targetActive: number;
  idleMilliseconds: number;
  maximum: number;
  defer(work: Promise<unknown>): void;
  wrap(response: Response, lease: NativeStreamLease): Response;
  now(): number;
  enabled?(): boolean;
  changed?(): void;
  keepReady?(identity: SlotIdentity): Promise<boolean>;
  balancePrimary?: boolean;
  recentDemandUntil?(): Promise<number>;
  primaryAvailable?(): boolean;
  primaryDistance?(): Promise<RuntimeDistance | undefined>;
  recoverPrimary?(): Promise<void>;
  demandAt?(at: number): void;
}

/** The concurrency target triggers growth; it never becomes another fixed inference cap. */
export class RuntimeFleet {
  private deps: Dependencies;
  private growing?: Promise<void>;
  private atCapacity = false;
  private primaryFailed = false;
  private primaryPlace: DistanceClass = "unknown";
  // Draws since the last admitted cell; in memory, so an isolate restart allows at most one more round.
  private draws = 0;
  private primaryFailure = 0;
  private nextGrowthCheck = 0;
  private growthAlarm?: number;
  private cells = new Map<string, { target: SlotTarget; cell: FleetCell }>();
  private dispatches = new FleetDispatches();
  private failures: FleetFailures;
  constructor(deps: Dependencies) {
    if (
      !Number.isSafeInteger(deps.targetActive) ||
      deps.targetActive < 1 ||
      !Number.isSafeInteger(deps.idleMilliseconds) ||
      deps.idleMilliseconds < 1 ||
      !Number.isSafeInteger(deps.maximum) ||
      deps.maximum < 1 ||
      deps.maximum > 4
    )
      throw new Error("Invalid runtime fleet policy");
    this.deps = deps;
    this.failures = new FleetFailures(deps.state, () => {
      this.atCapacity = false;
      this.nextGrowthCheck = 0;
      this.deps.changed?.();
      this.grow();
    });
  }
  refreshPolicy() {
    this.atCapacity = false;
    this.nextGrowthCheck = 0;
  }
  private cell(target: SlotTarget) {
    const retained = this.cells.get(target.slotId);
    if (retained) {
      if (!sameTarget(retained.target, target)) throw new FleetRefused("identity");
      return retained.cell;
    }
    const cell = this.deps.cell(target);
    this.cells.set(target.slotId, { target, cell });
    return cell;
  }
  private grow() {
    if (this.deps.enabled?.() === false) return;
    if (this.atCapacity) return;
    if (this.deps.now() < this.nextGrowthCheck) {
      if (this.growthAlarm !== this.nextGrowthCheck) {
        this.growthAlarm = this.nextGrowthCheck;
        this.deps.demandAt?.(this.nextGrowthCheck);
      }
      return;
    }
    this.growthAlarm = undefined;
    if (!this.growing) {
      this.nextGrowthCheck = this.deps.now() + 100;
      this.growing = this.addDemandedRuntime().finally(() => {
        this.growing = undefined;
        this.deps.changed?.();
      });
      this.deps.defer(this.growing.catch(() => {}));
    }
  }
  private async addDemandedRuntime() {
    while (true) {
      if (this.deps.enabled?.() === false) return;
      const rows = await this.deps.state.inspect();
      const physical = await this.deps.state.physicalCount();
      const active = Math.max(
        this.deps.currentRequests(),
        (await this.deps.legacyActive()) + rows.reduce((sum, row) => sum + row.active, 0),
      );
      if (physical >= this.deps.maximum) this.atCapacity = true;
      const minimum = this.deps.now() < ((await this.deps.recentDemandUntil?.()) ?? 0) ? 1 : 0;
      const desired = Math.min(
        this.deps.maximum,
        Math.max(minimum, Math.floor(active / this.deps.targetActive)),
      );
      const replacements = await this.deps.state.replacements();
      if (physical >= this.deps.maximum) return;
      if (
        !replacements &&
        (rows.length >= desired ||
          rows.some((row) => row.phase === "reserved" || row.phase === "warming"))
      )
        return;
      const target = await this.deps.target(rows.map((row) => row.target));
      if (replacements) await this.deps.state.reserveReplacement(target);
      else await this.deps.state.reserve(target);
      await this.start(target);
    }
  }
  private async start(target: SlotTarget) {
    await this.deps.state.dispatch(target);
    try {
      const cell = this.cell(target);
      await this.admit(cell, await cell.start(target));
    } catch (error) {
      await this.deps.state.uncertain(target);
      throw error;
    }
  }
  /**
   * Reads a started cell's distance before it can take a request. A far cell is redrawn only while
   * another runtime serves and draws remain: it goes straight to draining, so nothing is routed to it,
   * and the ordinary drain and retirement stop it gracefully once it has no activity.
   */
  private async admit(cell: FleetCell, identity: SlotIdentity) {
    const database = await cell
      .healthy?.(identity)
      .then((value) => value ?? undefined)
      .catch(() => undefined);
    const draw = this.draws + 1;
    const place = distanceClass(database);
    const decision: PlacementDecision =
      place === "near"
        ? "admit"
        : place === "unknown"
          ? "admit_unknown"
          : draw >= placementDraws
            ? "admit_after_limit"
            : !(await this.othersServing(identity))
              ? "admit_alone"
              : "redraw";
    if (decision === "redraw") {
      this.draws = draw;
      await this.deps.state.redraw(identity, database);
      logPlacement(identity, database, decision, draw);
      this.nextGrowthCheck = 0;
      return;
    }
    this.draws = 0;
    await this.deps.state.ready(identity);
    await this.deps.state.observeDistance(identity, database);
    logPlacement(identity, database, decision, draw);
  }
  private async othersServing(identity: SlotIdentity) {
    if (this.deps.primaryAvailable?.() !== false && !this.primaryFailed) return true;
    const rows = await this.deps.state.inspect();
    return rows.some(
      (row) => row.phase === "ready" && row.identity && !sameIdentity(row.identity, identity),
    );
  }
  private placement() {
    return { comfortable: this.deps.targetActive, primary: this.primaryPlace };
  }
  async recoverPrimary() {
    const failure = this.primaryFailure;
    await this.deps.recoverPrimary?.();
    if (failure === this.primaryFailure) this.primaryFailed = false;
  }
  async forward(
    request: Request,
    pool: string | undefined,
    legacy: (request: Request, beforeDispatch: () => void) => Promise<Response>,
    beforeDispatch: () => void,
  ) {
    let acquired;
    try {
      acquired = await this.dispatches.acquire(() =>
        this.deps.balancePrimary && !this.primaryFailed && this.deps.primaryAvailable?.() !== false
          ? this.deps.state.acquire(Number.MAX_SAFE_INTEGER, true, this.placement())
          : this.deps.state.acquire(Number.MAX_SAFE_INTEGER, false, this.placement()),
      );
    } catch (error) {
      if (!(error instanceof FleetRefused) || error.reason !== "capacity")
        refuseRuntime("fleet_acquire", error);
      // Start legacy admission before reading pressure so the triggering request is counted too.
      if (this.primaryFailed || this.deps.primaryAvailable?.() === false)
        throw new FleetRefused("capacity");
      const response = legacy(request, beforeDispatch);
      this.grow();
      return response;
    }
    const { reservation, dispatched } = acquired;
    let step: "primary_forward" | "fleet_identity" | "fleet_forward" =
      reservation.kind === "primary" ? "primary_forward" : "fleet_identity";
    this.grow();
    try {
      if (reservation.kind === "primary") {
        const response = await legacy(request, beforeDispatch);
        return this.deps.wrap(response, {
          signal: request.signal,
          onClose: () => {},
          release: () => {
            this.deps.defer(reservation.release().then(() => this.deps.changed?.()));
            return true;
          },
        });
      }
      const cell = this.cell(reservation.identity);
      this.failures.assertAvailable(reservation.identity);
      if (!sameIdentity(await cell.selected(), reservation.identity))
        throw new FleetRefused("uncertain");
      step = "fleet_forward";
      const response = await cell.forward(request, 8317, pool, () => {
        this.failures.assertAvailable(reservation.identity);
        beforeDispatch();
        dispatched();
      });
      return this.deps.wrap(response, {
        signal: request.signal,
        onClose: () => {},
        failed: (error) => this.failures.failed(reservation.identity, error, request.signal),
        release: () => {
          this.deps.defer(reservation.release().then(() => this.deps.changed?.()));
          return true;
        },
      });
    } catch (error) {
      rememberRuntimeFailure(step, error);
      if (reservation.kind === "primary") {
        this.primaryFailed = true;
        this.primaryFailure++;
        if (this.deps.recoverPrimary) this.deps.defer(this.recoverPrimary().catch(() => {}));
      }
      if (reservation.kind === "runtime") {
        try {
          await this.failures.failed(reservation.identity, error, request.signal);
        } catch {
          throw error;
        }
      }
      try {
        await reservation.release();
      } catch (releaseError) {
        refuseRuntime("fleet_release", releaseError);
      }
      throw error;
    } finally {
      dispatched();
    }
  }
  async install(policy: NativeMembershipPolicy) {
    const rows = await this.deps.state.inspect();
    await Promise.all(
      rows.map(async (row) => {
        if (row.phase === "quarantined") return;
        const cell = this.cell(row.target);
        if (await cell.selected()) await cell.install(policy);
      }),
    );
  }
  abortPool(pool: string) {
    for (const { cell } of this.cells.values()) cell.abortPool(pool);
  }
  async drain(identity: SlotIdentity) {
    const trace = new PoolUpkeepTrace("fleet");
    await trace.run(
      "drain_fence",
      () => this.dispatches.fence(identity, () => this.deps.state.drain(identity)),
      { ordinal: identity.homePeerOrdinal },
    );
    const actual = await trace.run("drain_recheck", () => this.cell(identity).drain(identity), {
      ordinal: identity.homePeerOrdinal,
    });
    trace.event("drain_recheck", {
      ordinal: identity.homePeerOrdinal,
      active: actual.active,
      known: actual.known,
    });
    await this.deps.state.acknowledgeDrain(identity);
    return actual;
  }
  async upkeep() {
    const trace = new PoolUpkeepTrace("fleet");
    return trace.run("upkeep", async () => {
      this.primaryPlace = distanceClass(await this.deps.primaryDistance?.().catch(() => undefined));
      const rows = await trace.run("snapshot", () => this.deps.state.inspect());
      await Promise.all(
        rows
          .filter((row) => row.phase === "ready" && row.identity)
          .map(async (row) => {
            try {
              const database = await this.cell(row.target).healthy?.(row.identity!);
              await this.deps.state.observeDistance(row.identity!, database ?? undefined);
            } catch (error) {
              await this.failures.failed(row.identity!, error, new AbortController().signal);
            }
          }),
      );
      const surviving = await this.deps.state.inspect();
      for (const row of surviving) {
        await trace.run(
          row.phase,
          async () => {
            const cell = this.cell(row.target);
            if (row.phase === "quarantined" && row.identity) {
              if (await cell.failed(row.identity, row.active)) {
                await this.deps.state.reclaimQuarantined(row.identity);
                this.cells.delete(row.target.slotId);
                this.atCapacity = false;
                this.nextGrowthCheck = 0;
              }
            } else if (row.phase === "reserved") {
              if (this.deps.enabled?.() === false) {
                await this.deps.state.cancelReserved(row.target);
                this.cells.delete(row.target.slotId);
                return;
              }
              await this.start(row.target);
            } else if (row.phase === "warming" || row.phase === "uncertain") {
              const observed = await cell.observe(row.target, this.deps.enabled?.() !== false);
              if (observed) await this.admit(cell, observed);
            } else if (
              row.phase === "ready" &&
              row.identity &&
              (row.active === 0 || this.deps.enabled?.() === false) &&
              (this.deps.enabled?.() === false || !(await this.deps.keepReady?.(row.identity))) &&
              (this.deps.enabled?.() === false ||
                this.deps.now() >= ((await this.deps.recentDemandUntil?.()) ?? 0) ||
                !sameIdentity(
                  surviving.find((value) => value.phase === "ready")?.identity,
                  row.identity,
                )) &&
              (this.deps.enabled?.() === false ||
                this.deps.now() - row.lastUsedAt >= this.deps.idleMilliseconds)
            ) {
              await this.drain(row.identity);
            } else if (row.phase === "draining" && row.identity) {
              const actual = await this.drain(row.identity);
              if (row.active !== 0 || actual.active !== 0 || !actual.known) return;
              const identity = row.identity;
              await cell.retire(identity, () => this.deps.state.beginRetirement(identity));
              this.cells.delete(row.target.slotId);
              await this.deps.state.retired(row.identity);
              this.atCapacity = false;
            } else if (
              row.phase === "retiring" &&
              row.identity &&
              row.active === 0 &&
              row.drainAcknowledged === true &&
              (await cell.retired(row.identity, true))
            ) {
              this.cells.delete(row.target.slotId);
              await this.deps.state.retired(row.identity);
              this.atCapacity = false;
            }
          },
          { ordinal: row.target.homePeerOrdinal, active: row.active },
        );
      }
      this.grow();
    });
  }
}
