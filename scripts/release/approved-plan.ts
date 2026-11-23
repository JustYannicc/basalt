import { createHash } from "node:crypto";

/**
 * The plan a person read, as one digest, so a deploy applies only that plan (#1810). A deploy plans
 * again before it applies, and an unchanged commit can plan differently five minutes later, so the
 * deploy compares its own plan with the one approved and refuses on any difference before it writes.
 *
 * The digest covers the commit, whether the fleet's classes are declared, every changed row as
 * production.ts prints it (name, type, action), and the Workers it re-points forward, which are
 * writes the rows don't show. Rows are sorted, so the plan's own order never matters.
 */
export interface PlanRow {
  readonly fqn: string;
  readonly resourceType: string;
  readonly action: string;
}

export interface PlanReading {
  readonly candidate: string;
  readonly declared: boolean;
  readonly rows: readonly PlanRow[];
  readonly forward: readonly string[];
}

/** The plan as the digest reads it: the changed rows, then the re-points, each sorted. */
export const planLines = ({ rows, forward }: Pick<PlanReading, "rows" | "forward">) => [
  ...rows
    .filter((row) => row.action !== "noop")
    .map((row) => `${row.fqn} ${row.resourceType} ${row.action}`)
    .sort(),
  ...[...forward].sort().map((fqn) => `${fqn} re-point forward`),
];

export const planDigest = (plan: PlanReading) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        candidate: plan.candidate,
        fleetClasses: plan.declared ? "declared" : "absent",
        lines: planLines(plan),
      }),
    )
    .digest("hex");

const DIGEST = /^[a-f0-9]{64}$/u;

/** A deploy goes ahead only with a plan digest; plan-only never needs one. */
export function deployApproval(
  mode: "plan" | "deploy",
  value: string | undefined,
): { readonly approved?: string; readonly refusal?: string } {
  if (mode === "plan") return {};
  const approved = value?.trim().toLowerCase() ?? "";
  if (!DIGEST.test(approved))
    return {
      refusal:
        "A deploy needs approved_plan: the plan digest a plan-only run of this commit printed; nothing applied",
    };
  return { approved };
}

/**
 * Why this deploy's plan is not the approved one, or nothing when it is. A digest cannot be read
 * back, so the approved rows are the ones the plan-only run printed beside its digest.
 */
export function planDifference(approved: string, plan: PlanReading) {
  const digest = planDigest(plan);
  if (digest === approved) return undefined;
  const lines = planLines(plan);
  return [
    `This plan (${digest}) is not the approved plan (${approved}); nothing applied.`,
    `This plan's rows: ${lines.join("; ") || "none"}.`,
    "The approved rows are the ones its plan-only run printed above its digest. Read this plan, then deploy with its digest.",
  ].join(" ");
}
