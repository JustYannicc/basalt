import {
  type RuntimeRouteDiagnostic,
  runtimeFailureDiagnostic,
} from "./runtime-route-diagnostic.ts";

type Phase =
  | "alarm"
  | "deadlines"
  | "fleet"
  | "rearm"
  | "home"
  | "home_shared"
  | "app_models"
  | "memberships"
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
  | "snapshot"
  | "reserved"
  | "warming"
  | "uncertain"
  | "ready"
  | "draining"
  | "retiring"
  | "retired"
  | "drain_recheck"
  | "drain_fence"
  | "drain_queue"
  | "drain_health"
  | "drain_activity"
  | "legacy_drain_proof";
interface Fields {
  ordinal?: number;
  active?: number;
  known?: boolean;
  homeDue?: boolean;
  fleetDue?: boolean;
  homeDeadline?: number | null;
  fleetDeadline?: number | null;
  nativeDeadline?: number | null;
}
let sequence = 0;

/** Timed closed phases distinguish a missing alarm from a held dependency without logging identities. */
export class PoolUpkeepTrace {
  private invocation = ++sequence;
  private side: "alarm" | "home" | "fleet" | "endpoint";
  constructor(side: "alarm" | "home" | "fleet" | "endpoint") {
    this.side = side;
  }
  event(phase: Phase, fields: Fields = {}) {
    this.emit(phase, "observed", performance.now(), fields);
  }
  private emit(
    phase: Phase,
    outcome: "started" | "pending" | "ended" | "error" | "observed",
    began: number,
    fields: Fields = {},
    reason?: RuntimeRouteDiagnostic["runtimeReason"],
  ) {
    console.info("POOL_RUNTIME_UPKEEP", {
      at: Date.now(),
      invocation: this.invocation,
      side: this.side,
      phase,
      outcome,
      elapsedMs: Math.max(0, Math.round(performance.now() - began)),
      ...fields,
      ...(reason ? { reason } : {}),
    });
  }
  async run<T>(phase: Phase, work: () => Promise<T>, fields: Fields = {}) {
    const began = performance.now();
    this.emit(phase, "started", began, fields);
    const pending = setTimeout(() => this.emit(phase, "pending", began, fields), 1_000);
    try {
      const value = await work();
      this.emit(phase, "ended", began, fields);
      return value;
    } catch (error) {
      this.emit(
        phase,
        "error",
        began,
        fields,
        runtimeFailureDiagnostic(error, "endpoint_route").runtimeReason,
      );
      throw error;
    } finally {
      clearTimeout(pending);
    }
  }
}
