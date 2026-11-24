import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { changedInputs, selectPaths } from "./affected.ts";
import { heavyJobs } from "./areas.ts";
import { githubObserver, placementMarker, routeBox } from "./box-router.ts";
import { fastJobs } from "./gate.ts";
import { declaredMatrices } from "./shards.ts";

const root = process.cwd();
const full = process.argv.includes("--all");
const fast = process.argv.includes("--fast");
if (full && fast) throw new Error("Choose one CI lane");
let selection;
try {
  const { changed, inputs } = full
    ? { changed: [], inputs: [] }
    : fast
      ? { changed: [], inputs: [] }
      : changedInputs(root, process.env.BASE_SHA ?? "", process.env.HEAD_SHA ?? "");
  selection = { ...selectPaths(inputs), changed, inputs, full };
  if (full) selection.jobs = [...heavyJobs];
} catch {
  selection = { ...selectPaths([]), jobs: [...heavyJobs], changed: [], inputs: [], full: true };
  console.log("::warning::Changed inputs could not be resolved. Every heavy CI job is selected.");
}
const output = ".generated/ci/selection.json";
const matrices = declaredMatrices(selection.full ? null : selection.declaredFiles);
const env = process.env;
const box = await routeBox(
  {
    event: env.GITHUB_EVENT_NAME ?? "",
    ref: env.GITHUB_REF ?? "",
    attempt: env.GITHUB_RUN_ATTEMPT,
    repository: env.GITHUB_REPOSITORY,
    headRepository: env.HEAD_REPOSITORY,
    slots: env.BOX_SLOTS,
    label: env.BOX_LABEL,
    // The fast lane's jobs run in every Check, so they can route as well as the selected ones.
    selected: [...fastJobs, ...selection.jobs],
    heartbeatLabel: env.BOX_HEARTBEAT_LABEL,
    matrices,
  },
  githubObserver({
    api: env.GITHUB_API_URL ?? "https://api.github.com",
    repository: env.GITHUB_REPOSITORY ?? "",
    token: env.GITHUB_TOKEN ?? "",
    runId: env.GITHUB_RUN_ID ?? "",
    label: env.BOX_LABEL ?? "",
    heartbeatLabel: env.BOX_HEARTBEAT_LABEL ?? "",
  }),
);
const routed = { ...selection, matrices, boxJobs: box.jobs, boxRouting: box.summary };
// Other Checks' selects read this to count these jobs before GitHub lists them.
if (box.jobs.length) console.log(`::notice::${placementMarker}${JSON.stringify(box.jobs)}`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(routed, null, 2));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    "full_suite=" +
      String(routed.full) +
      "\n" +
      "jobs=" +
      JSON.stringify(routed.jobs) +
      "\n" +
      "box_jobs=" +
      JSON.stringify(routed.boxJobs) +
      "\n" +
      // The label routing validated; runs-on reads it here, never the variable at job time.
      "box_label=" +
      box.label +
      "\n" +
      // box-watch's bound for jobs the box holds back: a waiting box job never outlasts it.
      "box_floor=" +
      String(Math.ceil(box.floor)) +
      "\n" +
      // Each box job's planned minutes and wave: box-watch's deadline for it.
      "box_plan=" +
      JSON.stringify(box.plan) +
      "\n" +
      "matrices=" +
      JSON.stringify(matrices) +
      "\n",
  );
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    (routed.full
      ? "Full suite.\n\n"
      : fast
        ? "PR fast lane. Heavy suites were not run.\n\n"
        : "Affected suites.\n\n") +
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
      "\n\n" +
      box.summary +
      "\n",
  );
console.log(JSON.stringify(routed, null, 2));
