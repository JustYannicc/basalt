import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { changedInputs, selectPaths } from "./affected.ts";
import { heavyJobs } from "./areas.ts";
import { fastConfigs } from "./declarations.ts";
import { laneBase, type Lane } from "./gate.ts";

/** The lane an event asks for, in select's order: the full suite, else this repository's affected lane, else fast. */
export const requestedLane = (env: { FULL_SUITE?: string; AFFECTED_LANE?: string }): Lane =>
  env.FULL_SUITE === "true" ? "full" : env.AFFECTED_LANE === "true" ? "affected" : "fast";

/**
 * The lane a Check runs and the heavy jobs it selects; changed inputs that can't be resolved run
 * the full suite. select, fast and fast-units each call this from the same comparison, so the
 * jobs that start beside select run the lane select chooses.
 */
export function selectLane(requested: Lane, root: string, base: string, head: string) {
  try {
    const { changed, inputs } =
      requested === "affected" ? changedInputs(root, base, head) : { changed: [], inputs: [] };
    const selection = { ...selectPaths(inputs), changed, inputs, full: requested === "full" };
    if (selection.full) selection.jobs = [...heavyJobs];
    return { lane: requested, selection, resolved: true };
  } catch {
    const selection = { ...selectPaths([]), changed: [], inputs: [], full: true };
    selection.jobs = [...heavyJobs];
    return { lane: "full" as Lane, selection, resolved: false };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const { lane, selection, resolved } = selectLane(
    requestedLane(env),
    process.cwd(),
    env.BASE_SHA ?? "",
    env.HEAD_SHA ?? "",
  );
  if (!resolved)
    console.log("::warning::Changed inputs could not be resolved; this is the full lane.");
  console.log("Lane: " + lane);
  // The fast job's e2e config step runs on the configs this lane reaches, as select computes
  // them for the heavy jobs, so fast need not wait for select.
  const configs = fastConfigs(selection.full ? null : selection.declaredFiles);
  // lane_base is what the aggregate compares with select's lane and comparison commit.
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `lane=${lane}\nfull_suite=${String(lane === "full")}\nlane_base=${laneBase(lane, env.BASE_SHA ?? "")}\nfast_configs=${JSON.stringify(configs)}\n`,
    );
}
