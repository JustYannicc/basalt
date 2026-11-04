import { fileURLToPath } from "node:url";
import { heavyJobs } from "./areas.ts";

export const fastJobs = ["select", "fast", "cpa-pipeline", "client-connection", "boat-check"];
export const bundleJobs = ["boat-bundle"];

export function gateErrors(
  needs: Record<string, { result: string }>,
  selected: readonly string[],
  boat: readonly string[] = [],
) {
  const errors: string[] = [];
  const expected = [...fastJobs, ...heavyJobs, ...bundleJobs];
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
      (selected.includes(job) && !boat.includes(job)) ||
      (bundleJobs.includes(job) && boat.length > 0);
    if (needs[job]?.result !== (required ? "success" : "skipped"))
      errors.push(
        `${job}: expected ${required ? "success" : "skipped"}, got ${needs[job]?.result ?? "missing"}`,
      );
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = gateErrors(
    JSON.parse(process.env.CI_NEEDS ?? "null"),
    JSON.parse(process.env.CI_JOBS ?? "null"),
    JSON.parse(process.env.CI_BOAT_JOBS ?? "null"),
  );
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
}
