import { fileURLToPath } from "node:url";
import { heavyJobs } from "./areas.ts";
import { routedJob } from "./box-router.ts";
import { checkedOutIdentity, retainReuseEvidence, validReuseEvidence } from "./reuse.ts";

export const fastJobs = [
  "select",
  "long-started",
  "fast",
  "cpa-pipeline",
  "client-connection",
  "browser-install",
];
// box-watch runs only in a Check that routed jobs to the box; it passes or is skipped. A run it
// cancels still reaches this gate, which runs on always(), and fails here; box-rerun.yml re-runs it.
export const conditionalJobs = ["workerd-assets", "box-watch"];

// The long tier: jobs that start as soon as `select` finishes. Every other job the selector starts
// also needs the trivial `long-started` job, so when a full Check queues more jobs than there are
// runners, the jobs that set its wall time are queued first. Membership: a non-declared job whose
// successful hosted runs average 10 minutes or more in full Checks 44515987650 and 44504964672
// (first attempts), plus workerd-assets, the short head of the upstream-image chain.
export const longJobs = [
  // Not long, but the watchdog of a Check's box jobs starts with them, ahead of the queue.
  "box-watch",
  "fast",
  "pool-runtime",
  "host-managed-accounts-pool",
  "account-acquisition",
  // Split from account-acquisition's group; planned at 11.3 minutes at the slowest measured pace.
  "account-observations",
  "host-managed-accounts",
  "production-ops-migrations",
  "catalog-compat",
  "host-managed-accounts-local",
  "production-ops",
  "human-in-the-loop-cloud",
  "host-managed-accounts-cloud",
  "human-in-the-loop",
  "planetscale-sign-in",
  "dashboard-batch",
  "account-usage",
  "workerd-assets",
];

/** full runs every heavy job, affected the ones the change reaches, fast none. */
export const lanes = ["full", "affected", "fast"] as const;
export type Lane = (typeof lanes)[number];

export function gateErrors(
  needs: Record<string, { result: string }>,
  selected: readonly string[],
  box: readonly string[] = [],
  lane?: Lane,
) {
  const errors: string[] = [];
  if (lane === "fast" && selected.length) errors.push("Fast lane selected heavy jobs");
  if (lane === "full" && [...selected].sort().join("\n") !== [...heavyJobs].sort().join("\n"))
    errors.push("Full suite must select every heavy job");
  const expected = [...fastJobs, ...heavyJobs, ...conditionalJobs];
  if (
    new Set(selected).size !== selected.length ||
    selected.some((job) => !heavyJobs.includes(job))
  )
    errors.push("Invalid heavy-job selection");
  // A routed job still passes under its own name below; routing only picks its runner.
  const routable = [...fastJobs, ...selected];
  if (new Set(box).size !== box.length || box.some((id) => !routable.includes(routedJob(id) ?? "")))
    errors.push("Invalid box-job selection");
  if (Object.keys(needs).sort().join("\n") !== [...expected].sort().join("\n"))
    errors.push("Aggregate gate dependencies differ from the declared CI jobs");
  for (const job of expected) {
    // box-watch runs when this Check routed jobs to the box; it may also be skipped, never fail.
    if (job === "box-watch") {
      const result = needs[job]?.result ?? "missing";
      if (result !== (box.length ? "success" : "skipped") && result !== "skipped")
        errors.push(`box-watch: expected success or skipped, got ${result}`);
      continue;
    }
    const required =
      fastJobs.includes(job) ||
      (job === "workerd-assets" && selected.includes("upstream-image")) ||
      selected.includes(job);
    if (needs[job]?.result !== (required ? "success" : "skipped"))
      errors.push(
        `${job}: expected ${required ? "success" : "skipped"}, got ${needs[job]?.result ?? "missing"}`,
      );
  }
  return errors;
}

export function reuseGateErrors(
  needs: Record<string, { result: string }>,
  evidence: unknown,
  identity: Parameters<typeof validReuseEvidence>[1],
  event: string,
  ref: string,
) {
  const expected = ["reuse", ...fastJobs, ...heavyJobs, ...conditionalJobs];
  const errors: string[] = [];
  if (event !== "push" || ref !== "refs/heads/main")
    errors.push("Only main pushes can reuse Check");
  if (!validReuseEvidence(evidence, identity)) errors.push("Invalid batch Check reuse evidence");
  if (Object.keys(needs).sort().join("\n") !== [...expected].sort().join("\n"))
    errors.push("Aggregate gate dependencies differ from the declared CI jobs");
  for (const job of expected) {
    const result = ["reuse", "cpa-pipeline"].includes(job) ? "success" : "skipped";
    if (needs[job]?.result !== result)
      errors.push(`${job}: expected ${result}, got ${needs[job]?.result ?? "missing"}`);
  }
  return errors;
}

export function runGateCli(env = process.env): void {
  const needs = JSON.parse(env.CI_NEEDS ?? "null");
  const { reuse, ...suite } = needs;
  if (env.CI_REUSED === "true") {
    const evidence: unknown = JSON.parse(env.CI_REUSE_EVIDENCE ?? "null");
    const identity = checkedOutIdentity(env.GITHUB_REPOSITORY ?? "");
    const errors = reuseGateErrors(
      needs,
      evidence,
      identity,
      env.GITHUB_EVENT_NAME ?? "",
      env.GITHUB_REF ?? "",
    );
    if (identity.head !== env.GITHUB_SHA)
      errors.push("Checkout differs from the triggering commit");
    if (errors.length) throw new Error(errors.join("\n"));
    if (validReuseEvidence(evidence, identity)) retainReuseEvidence(evidence, env);
    return;
  }
  if (reuse?.result !== "success")
    throw new Error(`reuse: expected success, got ${reuse?.result ?? "missing"}`);
  const lane = lanes.find((name) => name === env.CI_LANE);
  // The fast job's full-only steps read full_suite, so it must agree with the lane.
  if (!lane || env.CI_FULL_SUITE !== String(lane === "full"))
    throw new Error("Missing or invalid CI lane");
  const errors = gateErrors(
    suite,
    JSON.parse(env.CI_JOBS ?? "null"),
    JSON.parse(env.CI_BOX_JOBS ?? "null"),
    lane,
  );
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runGateCli();
