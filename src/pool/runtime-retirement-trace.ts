import {
  runtimeFailureDiagnostic,
  type RuntimeRouteDiagnostic,
} from "./runtime-route-diagnostic.ts";

type Phase =
  | "attempt"
  | "provider_observe"
  | "driver_retire"
  | "driver_retirement"
  | "provider_absent"
  | "witness_read"
  | "health"
  | "activity_retire"
  | "activity_read"
  | "destroy"
  | "retired_record";
interface Fields {
  retired?: boolean;
  running?: boolean;
  identityMatches?: boolean;
  absent?: boolean;
  recovered?: boolean;
}
let sequence = 0;

/** Closed events survive a missing reply without identifying the runtime or exposing its settings. */
export class RuntimeRetirementTrace {
  private observation = ++sequence;
  private began = performance.now();
  private side: "cell" | "endpoint";
  private attempt: number;
  constructor(side: "cell" | "endpoint", attempt: number) {
    this.side = side;
    this.attempt = attempt;
    this.emit("attempt", "started", this.began);
  }
  private emit(
    phase: Phase,
    outcome: "started" | "pending" | "aborted" | "response" | "error",
    began: number,
    fields: Fields = {},
    reason?: RuntimeRouteDiagnostic["runtimeReason"],
  ) {
    console.info("POOL_RUNTIME_RETIREMENT", {
      observation: this.observation,
      side: this.side,
      attempt: this.attempt,
      phase,
      outcome,
      elapsedMs: Math.max(0, Math.round(performance.now() - began)),
      attemptElapsedMs: Math.max(0, Math.round(performance.now() - this.began)),
      ...fields,
      ...(reason ? { reason } : {}),
    });
  }
  async run<T>(
    phase: Phase,
    work: () => Promise<T>,
    fields?: (value: T) => Fields,
    signal?: AbortSignal,
  ) {
    const began = performance.now();
    const abort = () => this.emit(phase, "aborted", began);
    signal?.addEventListener("abort", abort, { once: true });
    const pending = setTimeout(() => this.emit(phase, "pending", began), 1_000);
    this.emit(phase, "started", began);
    try {
      const value = await work();
      this.emit(phase, "response", began, fields?.(value));
      return value;
    } catch (error) {
      this.emit(
        phase,
        "error",
        began,
        {},
        runtimeFailureDiagnostic(error, "endpoint_route").runtimeReason,
      );
      throw error;
    } finally {
      clearTimeout(pending);
      signal?.removeEventListener("abort", abort);
    }
  }
}
