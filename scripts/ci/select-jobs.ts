import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { changedInputs, selectPaths } from "./affected.ts";
import { heavyJobs } from "./areas.ts";
import { fastConfigs, readDeclarations } from "./declarations.ts";
import { githubObserver, routeBox } from "./box-router.ts";
import { fastJobs, type Lane } from "./gate.ts";
import { planDeclaredShards, readDeclaredDurations } from "./shards.ts";

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
const declared = selection.full ? null : selection.declaredFiles;
const declarations = readDeclarations();
const matrices = planDeclaredShards(declarations, readDeclaredDurations(), declared);
const configs = fastConfigs(declared, declarations);
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
// A changed-inputs selection that could not be resolved ran as the full suite, so it is one.
const lane: Lane = selection.full ? "full" : fast ? "fast" : "affected";
const routed = {
  ...selection,
  lane,
  matrices,
  fastConfigs: configs,
  boxJobs: box.jobs,
  boxRouting: box.summary,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(routed, null, 2));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    "full_suite=" +
      String(routed.full) +
      "\n" +
      "lane=" +
      lane +
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
      "\n" +
      // The fast job's e2e configs whose specs the change reaches; the step runs when any is.
      "fast_configs=" +
      JSON.stringify(configs) +
      "\n",
  );
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    {
      full: "Full suite.\n\n",
      fast: "PR fast lane. Heavy suites were not run.\n\n",
      affected: "Affected lane: the heavy jobs this change's files reach.\n\n",
    }[lane] +
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
      (configs.length && !selection.full
        ? "The fast job runs the e2e configs this change reaches: " + configs.join(", ") + ".\n\n"
        : "") +
      box.summary +
      "\n",
  );
console.log(JSON.stringify(routed, null, 2));
