import { fileURLToPath } from "node:url";
import { heavyJobs } from "./areas.ts";

export const fastJobs = ["select", "fast", "cpa-pipeline", "client-connection"];
export const conditionalJobs = ["baseline-probe", "workerd-assets"];

export function gateErrors(
  needs: Record<string, { result: string }>,
  selected: readonly string[],
  boat: readonly string[] = [],
  full?: boolean,
  baselineProbeRequired = false,
) {
  const errors: string[] = [];
  if (full === false && selected.length) errors.push("Fast lane selected heavy jobs");
  if (full === true && [...selected].sort().join("\n") !== [...heavyJobs].sort().join("\n"))
    errors.push("Full suite must select every heavy job");
  const expected = [...fastJobs, ...heavyJobs, ...conditionalJobs];
  if (
    new Set(selected).size !== selected.length ||
    selected.some((job) => !heavyJobs.includes(job))
  )
    errors.push("Invalid heavy-job selection");
  if (new Set(boat).size !== boat.length || boat.some((job) => !selected.includes(job)))
    errors.push("Invalid Boat-job selection");
  if (Object.keys(needs).sort().join("\n") !== [...expected].sort().join("\n"))
    errors.push("Aggregate gate dependencies differ from the declared CI jobs");
  for (const job of expected) {
    const required =
      fastJobs.includes(job) ||
      (job === "baseline-probe" && baselineProbeRequired) ||
      (job === "workerd-assets" && selected.includes("upstream-image")) ||
      selected.includes(job);
    if (needs[job]?.result !== (required ? "success" : "skipped"))
      errors.push(
        `${job}: expected ${required ? "success" : "skipped"}, got ${needs[job]?.result ?? "missing"}`,
      );
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!["true", "false"].includes(process.env.CI_FULL_SUITE ?? ""))
    throw new Error("Missing or invalid CI lane");
  if (!["true", "false"].includes(process.env.CI_BASELINE_PROBE ?? ""))
    throw new Error("Missing or invalid baseline probe selection");
  const errors = gateErrors(
    JSON.parse(process.env.CI_NEEDS ?? "null"),
    JSON.parse(process.env.CI_JOBS ?? "null"),
    JSON.parse(process.env.CI_BOAT_JOBS ?? "null"),
    process.env.CI_FULL_SUITE === "true",
    process.env.CI_BASELINE_PROBE === "true",
  );
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
}
