import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { changedInputs, jobRoutes, selectPaths } from "./affected.ts";
import { heavyJobs } from "./areas.ts";

const root = process.cwd();
const full = process.argv.includes("--all");
let selection;
try {
  const { changed, inputs } = full
    ? { changed: [], inputs: [] }
    : changedInputs(root, process.env.BASE_SHA ?? "", process.env.HEAD_SHA ?? "");
  selection = { ...selectPaths(inputs), changed, inputs, full };
  if (full) selection.jobs = [...heavyJobs];
} catch {
  selection = { ...selectPaths([]), jobs: [...heavyJobs], changed: [], inputs: [], full: true };
  console.log("::warning::Changed inputs could not be resolved. Every heavy CI job is selected.");
}
const output = ".generated/ci/selection.json";
const routed = { ...selection, ...jobRoutes(selection.jobs, process.env.BOAT_JOBS ?? "") };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(routed, null, 2));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    "jobs=" +
      JSON.stringify(routed.jobs) +
      "\n" +
      "hosted_jobs=" +
      JSON.stringify(routed.hostedJobs) +
      "\n" +
      "boat_jobs=" +
      JSON.stringify(routed.boatJobs) +
      "\n" +
      "boat_jobs_csv=" +
      routed.boatJobs.join(",") +
      "\n",
  );
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    "Selected " +
      selection.jobs.length +
      " of " +
      heavyJobs.length +
      " heavy jobs.\n\n" +
      selection.jobs
        .map(
          (job) =>
            "- " +
            job +
            ": " +
            (selection.reasons[job] ?? ["full suite"])
              .map((path) => JSON.stringify(path))
              .join(", "),
        )
        .join("\n") +
      "\n",
  );
console.log(JSON.stringify(routed, null, 2));
