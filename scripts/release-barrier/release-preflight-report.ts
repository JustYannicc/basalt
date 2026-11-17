import type { PreflightBridgeCounters, HealthTiming } from "./release-preflight-guard.ts";
import type { PreflightStepResult } from "./release-preflight.ts";
import type { RehearsalCounters } from "./release-resume-rehearsal.ts";

/** Any attempted write fails the preflight, even when the step that tried it was caught. */
export function preflightReport(input: {
  candidate: string | undefined;
  steps: readonly PreflightStepResult[];
  fatal?: string;
  state: RehearsalCounters;
  bridge: PreflightBridgeCounters;
  observedAt?: string;
}) {
  const mutations = {
    deniedStateWrites: input.state.state.writeAttempts,
    blockedHttpMutations: input.state.fetch.blockedMutationAttempts,
    refusedBridgeRequests: input.bridge.refused,
  };
  const failed =
    input.fatal !== undefined ||
    input.steps.some((step) => step.status === "refused" || step.status === "skipped") ||
    mutations.deniedStateWrites > 0 ||
    mutations.blockedHttpMutations > 0 ||
    Object.keys(mutations.refusedBridgeRequests).length > 0;
  return {
    status: failed ? ("refused" as const) : ("pass" as const),
    candidate: input.candidate ?? null,
    ...(input.fatal ? { fatal: input.fatal } : {}),
    steps: input.steps,
    // Every active-health read, in order: the granted lease, the request leg and what was left.
    health: input.bridge.health,
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
    ...(report.health.length ? ["", ...report.health.map(healthLine)] : []),
    ...(report.fatal ? ["", `Fatal: ${report.fatal}`] : []),
    "",
    `Writes refused: ${JSON.stringify(report.mutations)}`,
    "",
  ].join("\n");
}
