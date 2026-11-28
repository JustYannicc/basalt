import type { FleetFailureRead } from "./runtime-fleet/failure-record.ts";
import {
  type RuntimeRouteDiagnostic,
  runtimeFailureDiagnostic,
} from "./runtime-route-diagnostic.ts";
import type { HomeDatabasePoolObservation } from "./home-database-pool.ts";
import type { RuntimeReadPhase, RuntimeReadSteps } from "./runtime-read-trace.ts";

/**
 * Each side's passes. No pass is also a phase on its own side, so a line that names one of its
 * side's passes and is not `pending` is that pass's line, never a phase's.
 */
interface Passes {
  alarm: "alarm";
  home: "home" | "home_shared" | "home_database_pool" | "model_history" | "model_history_shared";
  fleet: "upkeep" | "drain" | "supervise";
  endpoint: "warm" | "drain_queue";
}
type Side = keyof Passes;
type Phase =
  | Passes[Side]
  | "fleet"
  | "rearm"
  | "candidate_probe"
  | "primary_retirement"
  | "app_models"
  | "memberships"
  | "routes"
  | "computers"
  | "first_request"
  | "control"
  | "prices"
  | "overview_prices"
  | "usage"
  | "accounts"
  | "snapshot"
  | "reserved"
  | "warming"
  | "uncertain"
  | "quarantined"
  | "ready"
  | "draining"
  | "retiring"
  | "retired"
  | "drain_recheck"
  | "drain_fence"
  | "drain_health"
  | "drain_activity"
  | "legacy_drain_proof"
  | "keep_alive"
  // A readiness read's own steps, when it runs inside a pass.
  | RuntimeReadPhase;
type Inner<S extends Side> = Exclude<Phase, Passes[S]>;
type Outcome = "ended" | "error";
interface Fields {
  ordinal?: number;
  active?: number;
  known?: boolean;
  homeDue?: boolean;
  fleetDue?: boolean;
  homeDeadline?: number | null;
  fleetDeadline?: number | null;
  nativeDeadline?: number | null;
  nextHomeDeadline?: number | null;
  nextFleetDeadline?: number | null;
  nextNativeDeadline?: number | null;
  homeDatabasePool?: HomeDatabasePoolObservation | null;
}
interface Row {
  ordinal?: number;
  active?: number;
  phase: Phase;
  outcome: Outcome;
  elapsedMs: number;
}
interface Miss {
  ordinal?: number;
  quarantined: boolean;
  // A failed health read's closed cause, its measured round trip and, against a lease, what was left.
  cause: FleetFailureRead["cause"];
  roundTripMs?: number;
  leaseLeftMs?: number;
}
type Reason = RuntimeRouteDiagnostic["runtimeReason"];
let sequence = 0;
const elapsed = (began: number) => Math.max(0, Math.round(performance.now() - began));
const reasonOf = (error: unknown) =>
  runtimeFailureDiagnostic(error, "endpoint_route").runtimeReason;

/**
 * One line per pass, written when it settles, with every phase's time and which phases threw, so
 * each line answers on its own: a missing alarm reads apart from a held dependency without logging
 * identities or joining lines. A phase still running at 1 s and one that throws also get their own
 * line at once. Phases must settle inside their pass: one that ends after the line is not in it.
 */
export class PoolUpkeepTrace<S extends Side> {
  private invocation = ++sequence;
  private side: S;
  private phases: Partial<Record<Phase, number>> = {};
  private failed = new Set<Phase>();
  private rows: Row[] = [];
  private misses: Miss[] = [];
  private observed: Fields = {};
  constructor(side: S) {
    this.side = side;
  }
  private emit(
    phase: Phase,
    outcome: "pending" | "error",
    began: number,
    fields: Fields,
    reason?: Reason,
  ) {
    console.info("POOL_RUNTIME_UPKEEP", {
      at: Date.now(),
      invocation: this.invocation,
      side: this.side,
      phase,
      outcome,
      elapsedMs: elapsed(began),
      ...fields,
      ...(reason ? { reason } : {}),
    });
  }
  /** The pass, itself a phase: its line is written in `finally`, so a pass that throws still logs. */
  async pass<T>(phase: Passes[S], work: () => Promise<T>, fields: Fields = {}) {
    const began = performance.now();
    const pending = setTimeout(() => this.emit(phase, "pending", began, fields), 1_000);
    let failed: { reason: Reason } | undefined;
    try {
      return await work();
    } catch (error) {
      failed = { reason: reasonOf(error) };
      throw error;
    } finally {
      clearTimeout(pending);
      console.info("POOL_RUNTIME_UPKEEP", {
        at: Date.now(),
        invocation: this.invocation,
        side: this.side,
        phase,
        outcome: failed ? "error" : "ended",
        elapsedMs: elapsed(began),
        phases: { ...this.phases },
        ...(this.failed.size > 0 ? { failed: [...this.failed] } : {}),
        ...(this.rows.length > 0 ? { rows: [...this.rows] } : {}),
        ...(this.misses.length > 0 ? { misses: [...this.misses] } : {}),
        ...fields,
        ...this.observed,
        ...(failed?.reason ? { reason: failed.reason } : {}),
      });
    }
  }
  /** A phase that runs more than once in a pass, as rows sharing one do, adds up. */
  run<T>(phase: Inner<S>, work: () => Promise<T>, fields: Fields = {}) {
    return this.timed(phase, work, fields, () => {});
  }
  /** One fleet row's upkeep: its time adds to its phase's, and its entry says which row it was. */
  row<T>(phase: Inner<S>, fields: { ordinal?: number; active?: number }, work: () => Promise<T>) {
    return this.timed(phase, work, fields, (outcome, elapsedMs) =>
      this.rows.push({ ...fields, phase, outcome, elapsedMs }),
    );
  }
  private async timed<T>(
    phase: Phase,
    work: () => Promise<T>,
    fields: Fields,
    record: (outcome: Outcome, elapsedMs: number) => void,
  ) {
    const began = performance.now();
    const pending = setTimeout(() => this.emit(phase, "pending", began, fields), 1_000);
    let outcome: Outcome = "ended";
    try {
      return await work();
    } catch (error) {
      outcome = "error";
      this.failed.add(phase);
      this.emit(phase, "error", began, fields, reasonOf(error));
      throw error;
    } finally {
      clearTimeout(pending);
      const ms = elapsed(began);
      this.phases[phase] = (this.phases[phase] ?? 0) + ms;
      record(outcome, ms);
    }
  }
  observe(fields: Fields) {
    Object.assign(this.observed, fields);
  }
  missed(miss: Miss) {
    this.misses.push(miss);
  }
  /** A readiness read's own steps, timed as this pass's phases instead of their own lines. */
  readonly steps: RuntimeReadSteps = {
    run: (phase, work) => this.timed(phase, work, {}, () => {}),
  };
}

/**
 * What the fleet's upkeep writes to: its own `upkeep` pass, or, inside an alarm, that alarm's
 * `upkeep` phase. Its phases run on either side, so neither side may name one as a pass.
 */
export type FleetUpkeepTrace = Pick<PoolUpkeepTrace<"fleet" | "alarm">, "run" | "row" | "missed">;
