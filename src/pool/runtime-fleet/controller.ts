import {
  refuseRuntime,
  rememberRuntimeFailure,
  runtimeFailureCause,
  runtimeFailureDiagnostic,
} from "../runtime-route-diagnostic.ts";
import type { RuntimeEnd } from "../runtime-slots/container-end.ts";
import type { NativeStreamLease } from "../native-streams.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import {
  sameIdentity,
  sameTarget,
  type SlotIdentity,
  type SlotTarget,
} from "../runtime-slots/contract.ts";
import { FleetRefused, RuntimeFleetState, type FleetRow, type PrimaryRoute } from "./state.ts";
import {
  countStillMs,
  drainingBoundMs,
  inPhaseFor,
  logQuarantine,
  pastBound,
  quarantineReportMs,
  type PhaseBound,
} from "./phase-bounds.ts";
import { FleetDispatches } from "./dispatches.ts";
import {
  resumeGone,
  stampResumeTarget,
  streamResumeHeader,
  streamResumeVersion,
} from "../stream-resume.ts";
import { PoolUpkeepTrace } from "../upkeep-trace.ts";
import { FleetFailures } from "./failures.ts";
import { RootFallback, rootFallbackCounts, rootFallbackRefused } from "./root-fallback.ts";
import { distanceClass, type DistanceClass, type RuntimeDistance } from "../runtime-distance.ts";

/** A far cell is started again at most this many times before it serves from its last draw. */
export const placementDraws = 4;
type PlacementDecision =
  | "admit"
  | "admit_unknown"
  | "admit_alone"
  | "admit_after_limit"
  | "admit_replacement"
  | "redraw";

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

/** A cell's own stream count, and how long it stood still where the cell keeps it. */
export interface CellCount {
  active: number;
  known: boolean;
  stillMs?: number;
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
  /** The cell's own stream count, read without draining it; without it a ready count stays as is. */
  activity?(identity: SlotIdentity): Promise<CellCount>;
  /** Whether the cell is proven gone; false while its stop is still under way. */
  retire(identity: SlotIdentity, begin: () => Promise<void>): Promise<boolean>;
  retired(identity: SlotIdentity, resumeBeforeDispatch?: boolean): Promise<boolean>;
  failed(identity: SlotIdentity, active: number): Promise<boolean>;
  /** How the cell's container ended, as its last retirement or failure read said. */
  lastEnd?(identity: SlotIdentity): RuntimeEnd | undefined;
  /**
   * True only once no instance can run for a start that never served: nothing was ever sent, or the
   * provider proves the instance absent. Without it, such a row holds its place.
   */
  abandon?(target: SlotTarget): Promise<boolean>;
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
  /** How the root takes calls beside ready cells; without it, only when no cell has capacity. */
  primary?: PrimaryRoute;
  recentDemandUntil?(): Promise<number>;
  primaryAvailable?(): boolean;
  primaryDistance?(): Promise<RuntimeDistance | undefined>;
  recoverPrimary?(): Promise<void>;
  demandAt?(at: number): void;
}

/** A marked answer's cut mid-body, logged instead of counted against its runtime. */
function markedCut(identity: SlotIdentity, error: unknown, signal: AbortSignal) {
  // A client that left cut nothing, as for a runtime's own failures.
  if (signal.aborted) return;
  console.error(
    "POOL_RESUMABLE_STREAM_CUT",
    JSON.stringify({
      slot: identity.slotId,
      instance: identity.instanceId,
      kind: runtimeFailureDiagnostic(error, "fleet_forward").runtimeReason,
    }),
  );
}

/** The concurrency target triggers growth; it never becomes another fixed inference cap. */
export class RuntimeFleet {
  private deps: Dependencies;
  private growing?: Promise<void>;
  private atCapacity = false;
  private primaryFailed = false;
  private primaryPlace: DistanceClass = "unknown";
  // Far draws since the last admitted cell, any admission resetting it; in memory, so an isolate
  // restart allows at most one more round.
  private draws = 0;
  // Only this controller's own latest health read of the root counts as the root serving.
  private primaryServing = false;
  private primaryFailure = 0;
  private nextGrowthCheck = 0;
  private growthAlarm?: number;
  private cells = new Map<string, { target: SlotTarget; cell: FleetCell }>();
  private dispatches = new FleetDispatches();
  // In memory: a replaced isolate only reports a held row again, or counts an unproven drain afresh.
  private reported = new Map<string, number>();
  private unproven = new Map<string, number>();
  private failures: FleetFailures;
  private rootFallback: RootFallback;
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
    this.rootFallback = new RootFallback(() => deps.now());
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
      // A quarantined row holds its place but serves nothing, so it never stands in for a new cell.
      const serving = rows.filter((row) => row.phase !== "quarantined");
      if (
        !replacements &&
        (serving.length >= desired ||
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
    const row = (await this.deps.state.inspect()).find(
      (value) => value.target.slotId === identity.slotId,
    );
    // Growth and upkeep can both observe one start; only the first admits it.
    if (
      !row ||
      !["warming", "uncertain"].includes(row.phase) ||
      (row.identity && !sameIdentity(row.identity, identity))
    )
      return;
    const database = await cell
      .healthy?.(identity)
      .then((value) => value ?? undefined)
      .catch(() => undefined);
    const draw = this.draws + 1;
    const place = distanceClass(database);
    // A replacement keeps the demand that reserved it, so it serves wherever it landed.
    const replacing = row.replaces !== undefined || row.replacement === true;
    const decision: PlacementDecision =
      place === "near"
        ? "admit"
        : place === "unknown"
          ? "admit_unknown"
          : replacing
            ? "admit_replacement"
            : draw >= placementDraws
              ? "admit_after_limit"
              : !(await this.othersServing(identity))
                ? "admit_alone"
                : "redraw";
    if (decision === "redraw") {
      if (!(await this.deps.state.redraw(identity, database))) return;
      this.draws = draw;
      logPlacement(identity, database, decision, draw);
      return;
    }
    await this.deps.state.ready(identity, database);
    this.draws = 0;
    logPlacement(identity, database, decision, draw);
  }
  private async othersServing(identity: SlotIdentity) {
    if (this.primaryServing && this.deps.primaryAvailable?.() !== false && !this.primaryFailed)
      return true;
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
  /**
   * A root call that the fallback admitted stops waiting at its send. One that failed before its
   * send gives its token back, since a retry before dispatch is admitted again.
   */
  private rootCall(
    request: Request,
    legacy: (request: Request, beforeDispatch: () => void) => Promise<Response>,
    beforeDispatch: () => void,
    counted: boolean,
  ) {
    let waiting = counted;
    const release = (refund: boolean) => {
      if (waiting) this.rootFallback.release(refund);
      waiting = false;
    };
    let sending: Promise<Response>;
    try {
      sending = legacy(request, () => {
        release(false);
        beforeDispatch();
      });
    } catch (error) {
      sending = Promise.reject(error);
    }
    return sending.then(
      (response) => {
        release(false);
        return response;
      },
      (error: unknown) => {
        release(true);
        throw error;
      },
    );
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
        this.deps.primary && !this.primaryFailed && this.deps.primaryAvailable?.() !== false
          ? this.deps.state.acquire(Number.MAX_SAFE_INTEGER, this.deps.primary, this.placement())
          : this.deps.state.acquire(Number.MAX_SAFE_INTEGER, undefined, this.placement()),
      );
    } catch (error) {
      if (!(error instanceof FleetRefused) || error.reason !== "capacity")
        refuseRuntime("fleet_acquire", error);
      // With no sibling capacity the primary is the only route. A recent primary failure or a failed
      // recovery warm-up is only a hint: the request's own fresh admission on the primary decides.
      // Its rate is capped, so a burst can't starve the root's own Home; a refused call still grows.
      const counted = rootFallbackCounts(request);
      if (counted && !this.rootFallback.admit()) {
        this.grow();
        return rootFallbackRefused(request);
      }
      // Start legacy admission before reading pressure so the triggering request is counted too.
      const response = this.rootCall(request, legacy, beforeDispatch, counted).then((answer) =>
        stampResumeTarget(answer, { kind: "primary" }),
      );
      this.grow();
      return response;
    }
    const { reservation, dispatched } = acquired;
    // Grow before the root's cap admits, so nothing can stand between an admission and its call.
    this.grow();
    // The root as the only route takes the same capped rate as the capacity fallback above.
    const counted =
      reservation.kind === "primary" && reservation.alone && rootFallbackCounts(request);
    if (counted && !this.rootFallback.admit()) {
      dispatched();
      try {
        await reservation.release();
      } catch (error) {
        refuseRuntime("fleet_release", error);
      }
      return rootFallbackRefused(request);
    }
    let step: "primary_forward" | "fleet_identity" | "fleet_forward" =
      reservation.kind === "primary" ? "primary_forward" : "fleet_identity";
    try {
      if (reservation.kind === "primary") {
        const response = stampResumeTarget(
          await this.rootCall(request, legacy, beforeDispatch, counted),
          { kind: "primary" },
        );
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
      const response = stampResumeTarget(
        await cell.forward(request, 8317, pool, () => {
          this.failures.assertAvailable(reservation.identity);
          beforeDispatch();
          dispatched();
        }),
        { kind: "runtime", identity: reservation.identity },
      );
      // A marked answer runs through the front layer, and a cut mid-body can't tell a layer exit
      // from a node failure: it never counts against the runtime, which readiness and the layer's
      // pre-header `failed` still judge.
      const marked = response.headers.get(streamResumeHeader) === streamResumeVersion;
      return this.deps.wrap(response, {
        signal: request.signal,
        onClose: () => {},
        failed: (error) =>
          marked
            ? markedCut(reservation.identity, error, request.signal)
            : this.failures.failed(reservation.identity, error, request.signal),
        release: () => {
          this.deps.defer(reservation.release().then(() => this.deps.changed?.()));
          return true;
        },
      });
    } catch (error) {
      rememberRuntimeFailure(step, error);
      // A failed front layer leaves the runtime serving: no primary failure, no recovery.
      const layer = runtimeFailureDiagnostic(error, step).runtimeStep === "resume_layer";
      if (reservation.kind === "primary" && !layer) {
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
  /** The rest of a resumable answer from the runtime that served it; "gone" once it no longer runs. */
  async resume(identity: SlotIdentity, request: Request) {
    const cell = this.cell(identity);
    if (!sameIdentity(await cell.selected(), identity)) return resumeGone();
    return cell.forward(request, 8317, undefined, () => {});
  }
  /**
   * Every runtime that could take a new call must hold the policy before membership acknowledges it.
   * Each row settles on its own, so one runtime's refusal never stops the others or the root.
   */
  async install(policy: NativeMembershipPolicy) {
    const rows = await this.deps.state.inspect();
    const settled = await Promise.allSettled(
      rows.map(async (row) => {
        // A retiring or quarantined runtime takes no new call, so it never needs a policy.
        if (row.phase === "quarantined" || row.phase === "retiring") return;
        const cell = this.cell(row.target);
        if (!(await cell.selected())) return;
        try {
          await cell.install(policy);
        } catch (error) {
          // A draining runtime that can't return to ready takes no new call, so its refusal settles.
          if (row.phase === "draining" && row.redrawn !== true) return;
          // A starting runtime could still be admitted under its old policy, and a refusal from the
          // runtime's policy layer (cause "control"), such as an older revision racing a newer one,
          // is what the root answers too: both hold acknowledgement.
          if (
            !row.identity ||
            (row.phase !== "ready" && row.phase !== "draining") ||
            runtimeFailureCause(error) === "control"
          )
            throw error;
          // A serving runtime that failed leaves the selection: it takes no call under the old policy.
          await this.failures.refused(row.identity);
        }
      }),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
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
  /** One pass. Each row settles on its own, so one that throws never stops the others or growth. */
  async upkeep() {
    const trace = new PoolUpkeepTrace("fleet");
    return trace.run("upkeep", async () => {
      try {
        await this.upkeepRows(trace);
      } finally {
        this.grow();
      }
    });
  }
  private async upkeepRows(trace: PoolUpkeepTrace) {
    // The root's read runs beside the cells' reads; a failed one means "not proven serving".
    const primary = this.deps.primaryDistance
      ? this.deps.primaryDistance().then(
          (database) => ({ serving: true, database }),
          () => ({ serving: false, database: undefined }),
        )
      : Promise.resolve({ serving: true, database: undefined });
    const rows = await trace.run("snapshot", () => this.deps.state.inspect());
    await Promise.all(
      rows
        .filter((row) => row.phase === "ready" && row.identity)
        .map(async (row) => {
          let database;
          try {
            database = await this.cell(row.target).healthy?.(row.identity!);
          } catch (error) {
            const fields = { ordinal: row.target.homePeerOrdinal };
            await trace
              .run(
                "quarantined",
                () => this.failures.failed(row.identity!, error, new AbortController().signal),
                fields,
              )
              .catch(() => {});
            return;
          }
          // A failed distance write is not a failed runtime.
          await this.deps.state
            .observeDistance(row.identity!, database ?? undefined)
            .catch(() => {});
        }),
    );
    const root = await primary;
    this.primaryServing = root.serving;
    this.primaryPlace = distanceClass(root.database);
    let surviving = await this.deps.state.inspect();
    if (surviving.some((row) => row.phaseAt === undefined)) {
      await this.deps.state.stampPhases();
      surviving = await this.deps.state.inspect();
    }
    for (const row of surviving) {
      try {
        await trace.run(row.phase, () => this.upkeepRow(row, surviving), {
          ordinal: row.target.homePeerOrdinal,
          active: row.active,
        });
      } catch {
        // The trace logged this row's failure under its ordinal; the next alarm tries it again.
      }
    }
  }
  private async upkeepRow(row: FleetRow, rows: readonly FleetRow[]) {
    const enabled = this.deps.enabled?.() !== false;
    const now = this.deps.now();
    const cell = this.cell(row.target);
    if (row.phase === "quarantined") return this.holdQuarantined(cell, row, now);
    if (row.phase === "reserved") {
      if (!enabled) {
        await this.deps.state.cancelReserved(row.target);
        this.cells.delete(row.target.slotId);
        return;
      }
      if (pastBound(row, now)) return this.exceed(row, "start_unproven");
      return this.start(row.target);
    }
    if (row.phase === "warming" || row.phase === "uncertain") {
      // Past its bound a start is no longer observed: it holds its place until abandon() proves it.
      if (pastBound(row, now)) return this.exceed(row, "start_unproven");
      const observed = await cell.observe(row.target, enabled);
      if (observed) await this.admit(cell, observed);
      return;
    }
    const identity = row.identity;
    if (!identity) return;
    if (row.phase === "ready") {
      const active = await this.reconcileReady(cell, row, identity, now);
      if (!enabled || (await this.idle({ ...row, active }, identity, rows, now)))
        await this.drain(identity);
    } else if (row.phase === "draining") {
      if (row.redrawn === true && !(await this.othersServing(identity))) {
        // The runtime that justified the redraw stopped serving: keep the far one instead.
        if (await this.deps.state.restoreRedrawn(identity))
          logPlacement(identity, row.database, "admit_alone", this.draws);
        return;
      }
      await this.retireDrained(cell, row, identity, now);
    } else if (row.phase === "retiring") await this.finishRetirement(cell, row, identity, now);
  }
  private async exceed(row: FleetRow, reason: PhaseBound) {
    // pastBound() is false for a row without a stamped phase time.
    await this.deps.state.exceed(row.target, row.phase, row.phaseAt!, reason);
  }
  /** A quarantined row leaves only on proof that its instance can't run; until then it says so hourly. */
  private async holdQuarantined(cell: FleetCell, row: FleetRow, now: number) {
    const age = inPhaseFor(row, now);
    const reports = Math.floor(age / quarantineReportMs);
    if (reports > (this.reported.get(row.target.slotId) ?? 0)) {
      this.reported.set(row.target.slotId, reports);
      logQuarantine("held", row, age);
    }
    const absent = row.identity
      ? await cell.failed(row.identity, row.active)
      : ((await cell.abandon?.(row.target)) ?? false);
    if (!absent) return;
    if (row.identity)
      await this.deps.state.reclaimQuarantined(row.identity, cell.lastEnd?.(row.identity));
    else await this.deps.state.reclaimUnstarted(row.target);
    this.cells.delete(row.target.slotId);
    this.reported.delete(row.target.slotId);
    this.atCapacity = false;
    this.nextGrowthCheck = 0;
  }
  /** A ready count is read without draining the cell, so a cell is never drained to be read. */
  private async reconcileReady(
    cell: FleetCell,
    row: FleetRow,
    identity: SlotIdentity,
    now: number,
  ) {
    if (row.active === 0 || now - row.lastUsedAt < countStillMs || !cell.activity)
      return row.active;
    return this.reconcile(row, identity, await cell.activity(identity).catch(() => undefined), now);
  }
  /**
   * A ledger count may hold a lost release. Only the cell's own count lowers it, never below, so a
   * live stream of any length stays counted, and only once both counts stood still: a release whose
   * cell side just ended may still be on its way to the ledger.
   */
  private async reconcile(
    row: FleetRow,
    identity: SlotIdentity,
    counted: CellCount | undefined,
    now: number,
  ) {
    if (
      !counted?.known ||
      counted.active >= row.active ||
      now - row.lastUsedAt < countStillMs ||
      (counted.stillMs ?? 0) < countStillMs ||
      !(await this.deps.state.reconcileActive(identity, row, counted.active))
    )
      return row.active;
    console.warn("POOL_FLEET_COUNT_RECONCILED", {
      slot: identity.slotId,
      ordinal: identity.homePeerOrdinal ?? null,
      phase: row.phase,
      ledger: row.active,
      cell: counted.active,
    });
    return counted.active;
  }
  private async idle(
    row: FleetRow,
    identity: SlotIdentity,
    rows: readonly FleetRow[],
    now: number,
  ) {
    if (row.active !== 0 || now - row.lastUsedAt < this.deps.idleMilliseconds) return false;
    if (await this.deps.keepReady?.(identity)) return false;
    const first = rows.find((value) => value.phase === "ready")?.identity;
    if (now < ((await this.deps.recentDemandUntil?.()) ?? 0) && sameIdentity(first, identity))
      return false;
    // The last runtime that can take a call stays while the root can't take it.
    return this.othersServing(identity);
  }
  private async retireDrained(cell: FleetCell, row: FleetRow, identity: SlotIdentity, now: number) {
    let actual;
    try {
      actual = await this.drain(identity);
    } catch (error) {
      await this.unprovenDrain(row, now);
      throw error;
    }
    if (!actual.known) return this.unprovenDrain(row, now);
    this.unproven.delete(row.target.slotId);
    // The drain's count says nothing of how long it stood, so a lower one is read again alone.
    const active =
      row.active > actual.active && cell.activity
        ? await this.reconcile(
            row,
            identity,
            await cell.activity(identity).catch(() => undefined),
            now,
          )
        : row.active;
    if (active !== 0 || actual.active !== 0) return;
    if (!(await cell.retire(identity, () => this.deps.state.beginRetirement(identity)))) return;
    this.cells.delete(row.target.slotId);
    await this.deps.state.retired(identity, cell.lastEnd?.(identity));
    this.atCapacity = false;
  }
  /**
   * A drain unknown or unreadable for its whole bound is unproven. It counts from the first such
   * read this isolate saw, so a long drain that holds a live stream isn't quarantined by one failure.
   */
  private async unprovenDrain(row: FleetRow, now: number) {
    const since = this.unproven.get(row.target.slotId) ?? now;
    this.unproven.set(row.target.slotId, since);
    if (now - Math.max(since, row.phaseAt ?? now) < drainingBoundMs) return;
    this.unproven.delete(row.target.slotId);
    await this.exceed(row, "drain_unproven");
  }
  private async finishRetirement(
    cell: FleetCell,
    row: FleetRow,
    identity: SlotIdentity,
    now: number,
  ) {
    try {
      if (
        row.active === 0 &&
        row.drainAcknowledged === true &&
        (await cell.retired(identity, true))
      ) {
        this.cells.delete(row.target.slotId);
        await this.deps.state.retired(identity, cell.lastEnd?.(identity));
        this.atCapacity = false;
        return;
      }
    } catch (error) {
      if (pastBound(row, now)) await this.exceed(row, "absence_unproven");
      throw error;
    }
    if (pastBound(row, now)) await this.exceed(row, "absence_unproven");
  }
}
