import type { PreflightBridgeCounters, HealthTiming } from "./release-preflight-guard.ts";
import type { PreflightMode, PreflightStepResult } from "./release-preflight.ts";
import type { RehearsalCounters } from "./release-resume-rehearsal.ts";
import type { ControllerAttempt } from "./release-preflight-steps.ts";

/** Any attempted write fails the preflight, even when the step that tried it was caught. */
export function preflightReport(input: {
  candidate: string | undefined;
  /** A pending settlement blocks only the release; the Check that ships the settlement reports it. */
  mode: PreflightMode | undefined;
  steps: readonly PreflightStepResult[];
  fatal?: string;
  state: RehearsalCounters;
  bridge: PreflightBridgeCounters;
  /** Candidates of the release receipts that could name the live controller code. */
  receiptCandidates?: readonly string[];
  controllerAttempts?: readonly ControllerAttempt[];
  observedAt?: string;
}) {
  const mutations = {
    deniedStateWrites: input.state.state.writeAttempts,
    blockedHttpMutations: input.state.fetch.blockedMutationAttempts,
    refusedBridgeRequests: input.bridge.refused,
  };
  const failed =
    input.fatal !== undefined ||
    input.steps.some(
      (step) =>
        step.status === "refused" ||
        step.status === "skipped" ||
        (step.status === "settlement-required" && input.mode !== "check"),
    ) ||
    mutations.deniedStateWrites > 0 ||
    mutations.blockedHttpMutations > 0 ||
    Object.keys(mutations.refusedBridgeRequests).length > 0;
  return {
    status: failed ? ("refused" as const) : ("pass" as const),
    candidate: input.candidate ?? null,
    mode: input.mode ?? null,
    ...(input.fatal ? { fatal: input.fatal } : {}),
    steps: input.steps,
    // Every active-health read, in order: the granted lease, the request leg and what was left.
    health: input.bridge.health,
    receiptCandidates: input.receiptCandidates ?? [],
    controllerAttempts: input.controllerAttempts ?? [],
    mutations,
    reads: { state: input.state.state, http: input.state.fetch, bridge: input.bridge.dispatched },
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}

const stepLine = (result: PreflightStepResult) => {
  switch (result.status) {
    case "refused": {
      const field = result.refusal.field ? ` (${result.refusal.field})` : "";
      return `- ${result.step}: REFUSED ${result.refusal.reason}${field}`;
    }
    case "skipped":
      return `- ${result.step}: skipped, needs ${result.needs.join(", ")}`;
    case "not-applicable":
      return `- ${result.step}: not applicable (${result.why})`;
    case "settlement-required":
      return `- ${result.step}: SETTLEMENT REQUIRED (${result.disposition}); blocks the release until applied`;
    default:
      return `- ${result.step}: pass`;
  }
};

const ms = (value: number | null) => (value === null ? "?" : `${value} ms`);
const healthLine = (call: HealthTiming, index: number) =>
  [
    `- active-health #${index + 1}: lease ${ms(call.leaseMs)}`,
    `request leg ${ms(call.requestLegMs)}`,
    `bridge close ${ms(call.closeMs)}`,
    `margin ${ms(call.marginMs)}`,
    `bridge setup ${ms(call.setupMs)}`,
    `margin counting setup ${ms(call.setupInclusiveMarginMs)}`,
  ].join(", ");

export function preflightSummary(report: ReturnType<typeof preflightReport>) {
  return [
    `## Release preflight: ${report.status === "pass" ? "PASS" : "REFUSED"}`,
    "",
    ...report.steps.map(stepLine),
    ...(report.controllerAttempts.length
      ? [
          "",
          ...report.controllerAttempts.map(
            (attempt) =>
              `- inspect with ${attempt.source} code ${attempt.candidate.slice(0, 12)}/${attempt.workerInput.slice(0, 12)}: ${attempt.outcome === "accepted" ? "accepted" : `refused ${attempt.outcome.reason}`}`,
          ),
        ]
      : []),
    ...(report.health.length ? ["", ...report.health.map(healthLine)] : []),
    ...(report.fatal ? ["", `Fatal: ${report.fatal}`] : []),
    "",
    `Writes refused: ${JSON.stringify(report.mutations)}`,
    "",
  ].join("\n");
}
