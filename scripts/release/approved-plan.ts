import { createHash } from "node:crypto";

/**
 * The plan a person read, as one digest, so a deploy applies only that plan (#1810). A deploy plans
 * again before it applies, and an unchanged commit can plan differently five minutes later, so the
 * deploy compares its own plan with the one approved and refuses on any difference before it writes.
 *
 * The digest covers the commit, whether the fleet's classes are declared, and every write the plan
 * prints: each changed resource row with why it is in the plan and each stack action, as
 * production.ts prints them, the Durable Object classes it creates, and the Workers it re-points
 * forward. Each is sorted, so the plan's own order never matters.
 */
export interface PlanRow {
  readonly fqn: string;
  readonly resourceType: string;
  readonly action: string;
  readonly bindings?: readonly { readonly sid?: string; readonly action: string }[];
  /** The names of the top-level props Alchemy's own diff calls changed; never their values. */
  readonly changedProps?: readonly string[];
}

export interface PlanAction {
  readonly fqn: string;
  readonly actionType: string;
  readonly action: string;
}

export interface PlanReading {
  readonly candidate: string;
  readonly declared: boolean;
  readonly rows: readonly PlanRow[];
  readonly actions: readonly PlanAction[];
  readonly created: readonly string[];
  readonly forward: readonly string[];
}

/**
 * A resource row as the plan prints it, with why it is in the plan, or nothing when it changes
 * nothing. A noop row whose bindings change still writes, as the repository's own changed-row
 * reading counts it. Names only: a prop's or a binding's value can hold a secret.
 */
export const rowLine = (row: PlanRow) => {
  const bindings = (row.bindings ?? [])
    .filter((binding) => binding.action !== "noop")
    .map((binding) => `${binding.sid ?? "unnamed"} ${binding.action}`)
    .sort();
  const props = [...(row.changedProps ?? [])].sort();
  const head = `${row.fqn} ${row.resourceType} ${row.action}`;
  const bound = bindings.length ? `bindings ${bindings.join(", ")}` : "";
  if (row.action === "noop")
    return bindings.length ? `${head}, bindings changed: ${bound}` : undefined;
  // A new or removed resource is all new or all gone, so only a change names its props.
  if (row.action !== "update") return head;
  if (!props.length)
    return bindings.length
      ? `${head} only by its bindings, no prop changes: ${bound}`
      : `${head}, no prop or binding changes`;
  return `${head}: props ${props.join(", ")}${bound ? `; ${bound}` : ""}`;
};

/** Each plan row with the names of its changed props, from the repository's changed-row reading. */
export const withReasons = <Row extends PlanRow>(
  rows: readonly Row[],
  changed: readonly { readonly fqn: string; readonly changedProps: readonly string[] }[],
) => {
  const why = new Map(changed.map((row) => [row.fqn, row.changedProps]));
  return rows.map((row) => ({ ...row, changedProps: why.get(row.fqn) ?? [] }));
};

/** A stack action as the plan prints it, or nothing when it does not run. */
export const actionLine = (action: PlanAction) =>
  action.action === "noop" ? undefined : `${action.fqn} ${action.actionType} ${action.action}`;

/** The plan as the digest reads it: rows, actions, created classes, then re-points, each sorted. */
export const planLines = (plan: Omit<PlanReading, "candidate" | "declared">) => [
  ...plan.rows.flatMap((row) => rowLine(row) ?? []).sort(),
  ...plan.actions.flatMap((action) => actionLine(action) ?? []).sort(),
  ...[...plan.created].sort().map((name) => `${name} class created`),
  ...[...plan.forward].sort().map((fqn) => `${fqn} re-point forward`),
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
 * back, so the approved lines are the ones its plan-only run printed above its digest.
 */
export function planDifference(approved: string, plan: PlanReading) {
  const digest = planDigest(plan);
  if (digest === approved) return undefined;
  return [
    `This plan (${digest}) is not the approved plan (${approved}); nothing applied.`,
    `This plan, sorted: ${planLines(plan).join("; ") || "nothing"}.`,
    "The approved plan is the one its plan-only run printed above its digest. Read this plan, then deploy with its digest.",
  ].join(" ");
}
