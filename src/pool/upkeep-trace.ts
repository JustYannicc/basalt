import type { FleetFailureRead } from "./runtime-fleet/failure-record.ts";
import {
  type RuntimeRouteDiagnostic,
  runtimeFailureDiagnostic,
} from "./runtime-route-diagnostic.ts";
import type { HomeDatabasePoolObservation } from "./home-database-pool.ts";
import type { RuntimeReadPhase, RuntimeReadSteps } from "./runtime-read-trace.ts";

type Side = "alarm" | "home" | "fleet" | "endpoint";
type Phase =
  | "alarm"
  | "fleet"
  | "rearm"
  | "home"
  | "home_shared"
  | "candidate_probe"
  | "primary_retirement"
  | "app_models"
  | "memberships"
  | "home_database_pool"
  | "computers"
  | "warm"
  | "first_request"
  | "control"
  | "prices"
  | "overview_prices"
  | "usage"
  | "accounts"
  | "model_history"
  | "upkeep"
  | "supervise"
  | "snapshot"
  | "reserved"
  | "warming"
  | "uncertain"
  | "quarantined"
  | "ready"
  | "draining"
  | "retiring"
  | "retired"
  | "drain"
  | "drain_recheck"
  | "drain_fence"
  | "drain_queue"
  | "drain_health"
  | "drain_activity"
  | "legacy_drain_proof"
  | "keep_alive"
  // A readiness read's own steps, when it runs inside a pass.
  | RuntimeReadPhase;
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
 * One line per pass, written when it settles, with every phase's time, so a missing alarm reads
 * apart from a held dependency without logging identities. A phase still running at 1 s and one
 * that throws also get their own line at once. Phases must settle inside their pass: one that ends
 * after the line is not in it.
 */
export class PoolUpkeepTrace {
  private invocation = ++sequence;
  private side: Side;
  private phases: Partial<Record<Phase, number>> = {};
  private rows: Row[] = [];
  private misses: Miss[] = [];
  private observed: Fields = {};
  constructor(side: Side) {
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
  async pass<T>(phase: Phase, work: () => Promise<T>, fields: Fields = {}) {
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
        ...(this.rows.length > 0 ? { rows: [...this.rows] } : {}),
        ...(this.misses.length > 0 ? { misses: [...this.misses] } : {}),
        ...fields,
        ...this.observed,
        ...(failed?.reason ? { reason: failed.reason } : {}),
      });
    }
  }
  /** A phase that runs more than once in a pass, as rows sharing one do, adds up. */
  run<T>(phase: Phase, work: () => Promise<T>, fields: Fields = {}) {
    return this.timed(phase, work, fields, () => {});
  }
  /** One fleet row's upkeep: its time adds to its phase's, and its entry says which row it was. */
  row<T>(phase: Phase, fields: { ordinal?: number; active?: number }, work: () => Promise<T>) {
    return this.timed(phase, work, fields, (elapsedMs) =>
      this.rows.push({ ...fields, phase, elapsedMs }),
    );
  }
  private async timed<T>(
    phase: Phase,
    work: () => Promise<T>,
    fields: Fields,
    record: (elapsedMs: number) => void,
  ) {
    const began = performance.now();
    const pending = setTimeout(() => this.emit(phase, "pending", began, fields), 1_000);
    try {
      return await work();
    } catch (error) {
      this.emit(phase, "error", began, fields, reasonOf(error));
      throw error;
    } finally {
      clearTimeout(pending);
      const ms = elapsed(began);
      this.phases[phase] = (this.phases[phase] ?? 0) + ms;
      record(ms);
    }
  }
  observe(fields: Fields) {
    Object.assign(this.observed, fields);
  }
  missed(miss: Miss) {
    this.misses.push(miss);
  }
  /** A readiness read's own steps, timed as this pass's phases instead of their own lines. */
  readonly steps: RuntimeReadSteps = { run: (phase, work) => this.run(phase, work) };
}
