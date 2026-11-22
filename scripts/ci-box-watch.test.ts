import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { conditionalJobs, fastJobs, gateErrors, longJobs } from "./ci/gate.ts";
import { heavyJobs } from "./ci/areas.ts";
import {
  downMinutes,
  holdingMinutes,
  jobName,
  latestStart,
  watchDecision,
  type Planned,
  type WatchedJob,
} from "./ci/box-watch.ts";
import { parseVerdict, rerunDecision, type RerunJob, type Run } from "./ci/box-rerun.ts";
import { namedJobs } from "./ci/box-router.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const minute = 60_000;
const start = Date.parse("2026-11-21T16:00:00Z");
const job = (fields: Partial<WatchedJob> & { id: number }): WatchedJob => ({
  name: `job-${fields.id}`,
  status: "queued",
  onBox: true,
  ...fields,
});
const first: Planned = { minutes: 15, wave: 1 };
const watch = (
  jobs: WatchedJob[],
  at: number,
  downFor = 0,
  planned: Record<string, Planned> = Object.fromEntries(
    jobs.filter((j) => j.onBox).map((j) => [j.name, first]),
  ),
) =>
  watchDecision({
    jobs,
    planned,
    downFor,
    now: start + at * minute,
    selectedAt: start,
    floorMinutes: 20,
    run: 7,
    attempt: 1,
    self: "box-watch",
  });

test("box-watch is done once every planned box job has started, whatever runs hosted", () => {
  const jobs = [
    job({ id: 1, status: "in_progress" }),
    job({ id: 2, status: "completed" }),
    job({ id: 3, onBox: false }),
  ];
  for (const downFor of [0, 60]) assert.deepEqual(watch(jobs, 60, downFor), { action: "done" });
});

test("a planned box job not listed yet keeps box-watch waiting, and it never cancels for it", () => {
  const jobs = [job({ id: 1, status: "in_progress" })];
  const planned = { "job-1": first, "declared-cloud (7)": { minutes: 9, wave: 2 } as Planned };
  assert.deepEqual(watch(jobs, 1, 0, planned), { action: "wait" });
  // Unlisted means it still waits for its own needs: neither a down box nor its deadline cancels.
  assert.deepEqual(watch(jobs, 60, 60, planned), { action: "wait" });
  assert.equal(jobName("declared-cloud-7"), "declared-cloud-7");
  assert.equal(jobName("production-ops-identity:role"), "production-ops-identity (role)");
  // GitHub names a leg `job (value)` only for a one-key matrix with no name of its own; a job box-watch
  // can't find by name would hold its hosted runner until it gives up.
  const workflow = read(".github/workflows/ci.yml");
  for (const [id, named] of Object.entries(namedJobs)) {
    if (typeof named.minutes === "number") continue;
    const ci = workflow.jobs[id];
    assert.equal(ci.name, undefined, id);
    for (const leg of ci.strategy.matrix.include) assert.equal(Object.keys(leg).length, 1, id);
  }
});

test("a box down for the bound after box-watch's probe gets its queued jobs cancelled; before it, they wait", () => {
  const jobs = [
    job({ id: 1 }),
    job({ id: 2, status: "in_progress", onBox: false }),
    job({ id: 3, name: "box-watch", status: "in_progress", onBox: false }),
  ];
  assert.equal(downMinutes, 5);
  assert.deepEqual(watch(jobs, 2, downMinutes - 0.5), { action: "wait" });
  const cancel = watch(jobs, 2, downMinutes);
  assert.ok(cancel.action === "cancel");
  assert.deepEqual(cancel.verdict, {
    run: 7,
    attempt: 1,
    reason: "box-down",
    stuck: [1],
    // Jobs its cancel cuts off, never box-watch itself.
    cutOff: [2],
    at: new Date(start + 2 * minute).toISOString(),
  });
});

test("a healthy box may hold each job until its own latest start that still ends by the floor", () => {
  assert.equal(holdingMinutes, 5);
  // A first-wave job: the floor plus the margin. A waiting 4-minute job must still end by the
  // floor at 1.25x its minutes: 20 - 5 + 5 = 20 minutes after select.
  assert.equal(latestStart(first, 20), 25);
  const second: Planned = { minutes: 4, wave: 2 };
  assert.equal(latestStart(second, 20), 20);
  const jobs = [job({ id: 1 }), job({ id: 2 })];
  const planned = { "job-1": first, "job-2": second };
  // Up and holding: no down cancel, however long the job has queued, until its own deadline.
  assert.deepEqual(watch(jobs, 19.5, 0, planned), { action: "wait" });
  const late = watch(jobs, 20, 0, planned);
  assert.ok(late.action === "cancel");
  assert.equal(late.verdict.reason, "held-past-deadline");
  // Every stuck job goes with the cancel, not only the late one.
  assert.deepEqual(late.verdict.stuck, [1, 2]);
  assert.deepEqual(watch([job({ id: 1 })], 24.5, 0, { "job-1": first }), { action: "wait" });
  assert.equal(watch([job({ id: 1 })], 25, 0, { "job-1": first }).action, "cancel");
});

const run: Run = { id: 7, attempt: 1, conclusion: "cancelled" };
const verdict = JSON.stringify({
  run: 7,
  attempt: 1,
  reason: "box-down",
  stuck: [11, 12],
  cutOff: [13],
  at: "2026-11-21T16:05:00Z",
});
const boxJob = (id: number, name: string): RerunJob => ({
  id,
  name,
  conclusion: "cancelled",
  labels: ["basalt-box"],
  runnerName: null,
});
const jobs: RerunJob[] = [
  boxJob(11, "declared-cloud-1"),
  boxJob(12, "declared-cloud-2"),
  {
    id: 13,
    name: "fast",
    conclusion: "cancelled",
    labels: ["ubuntu-latest"],
    runnerName: "GitHub Actions 1",
  },
  { id: 14, name: "client-mobile", conclusion: "success", labels: ["ubuntu-latest"] },
  // The aggregate runs after any cancel and fails on the cancelled jobs.
  { id: 15, name: "check", conclusion: "failure", labels: ["ubuntu-latest"] },
];
const decide = (text: string | undefined, list = jobs, at = run) =>
  rerunDecision(at, text, list, "basalt-box");

test("box-rerun acts only on box-watch's own verdict for that very run's first attempt", () => {
  // A Check a person cancelled, or a superseded run force-cancelled: no verdict, nothing happens.
  assert.equal(decide(undefined).action, "none");
  for (const text of [
    "",
    "not json",
    "{}",
    JSON.stringify({ ...JSON.parse(verdict), run: 8 }),
    JSON.stringify({ ...JSON.parse(verdict), attempt: 2 }),
    JSON.stringify({ ...JSON.parse(verdict), reason: "other" }),
    JSON.stringify({ ...JSON.parse(verdict), stuck: [] }),
    JSON.stringify({ ...JSON.parse(verdict), stuck: ["11"] }),
  ])
    assert.equal(decide(text).action, "none", text);
  // A run that finished on its own is never re-run by this workflow.
  for (const conclusion of ["success", "failure", null])
    assert.equal(decide(verdict, jobs, { ...run, conclusion }).action, "none");
  // A re-run is attempt 2, which never routes and is never re-run here, even with a verdict for it.
  const second = JSON.stringify({ ...JSON.parse(verdict), attempt: 2 });
  assert.equal(decide(second, jobs, { ...run, attempt: 2 }).action, "none");
  assert.deepEqual(parseVerdict(verdict)?.stuck, [11, 12]);
});

test("a forged verdict can't re-run a run: its stuck jobs must be box jobs that never got a runner", () => {
  const forged = (stuck: number[]) => JSON.stringify({ ...JSON.parse(verdict), stuck });
  // A hosted job, a job that isn't in the run, a box job that got a runner, one that finished.
  for (const stuck of [[13], [11, 99], [14]])
    assert.equal(decide(forged(stuck)).action, "none", String(stuck));
  const held = jobs.map((j) => (j.id === 11 ? { ...j, runnerName: "box-3" } : j));
  assert.equal(decide(verdict, held).action, "none");
  const ran = jobs.map((j) => (j.id === 12 ? { ...j, conclusion: "success" } : j));
  assert.equal(decide(verdict, ran).action, "none");
  // No box label configured: nothing is a box job.
  assert.equal(rerunDecision(run, verdict, jobs, "").action, "none");
});

test("with no real failure the stuck and cut-off jobs re-run; a real failure leaves the run for a person", () => {
  // The aggregate's failure after the cancel is no real failure.
  assert.deepEqual(decide(verdict), { action: "rerun", stuck: [11, 12] });
  const fastOnly = jobs.map((j) => (j.name === "check" ? { ...j, name: "check (fast-only)" } : j));
  assert.deepEqual(decide(verdict, fastOnly), { action: "rerun", stuck: [11, 12] });
  const failed = [...jobs, { id: 16, name: "pool-runtime", conclusion: "failure" }];
  assert.deepEqual(decide(verdict, failed), {
    action: "report",
    why: "a job failed for real, so the run stays as it is for a person to classify",
    stuck: [11, 12],
    failed: ["pool-runtime"],
  });
});

test("box-watch watches a routed first attempt, keeps its verdict before it cancels, and leads the queue", () => {
  const workflow = read(".github/workflows/ci.yml");
  const box = workflow.jobs["box-watch"];
  assert.equal(box.needs, "select");
  assert.equal(box.if, "github.run_attempt == 1 && needs.select.outputs.box_jobs != '[]'");
  assert.equal(box["runs-on"], "ubuntu-latest");
  assert.deepEqual(box.permissions, { actions: "write", contents: "read" });
  const names = box.steps.map((step: { name?: string; uses?: string }) => step.name ?? step.uses);
  const keep = names.indexOf("Keep the verdict for box-rerun.yml");
  const cancel = names.indexOf("Cancel the run so its box jobs can run on GitHub's runners");
  assert.ok(keep > 0 && cancel > keep);
  assert.equal(box.steps[keep].with.name, "box-watch-verdict");
  assert.equal(workflow.jobs.select.outputs.box_floor, "${{ steps.jobs.outputs.box_floor }}");
  assert.equal(workflow.jobs.select.outputs.box_plan, "${{ steps.jobs.outputs.box_plan }}");
  const watchStep = box.steps.find((step: { id?: string }) => step.id === "watch");
  assert.equal(watchStep.env.BOX_PLAN, "${{ needs.select.outputs.box_plan }}");
  assert.ok(workflow.jobs.check.needs.includes("box-watch"));
  assert.ok(longJobs.includes("box-watch"));
  assert.ok(conditionalJobs.includes("box-watch"));
});

test("box-rerun runs the default branch's file after a cancelled Check, with nothing but its script", () => {
  const rerun = read(".github/workflows/box-rerun.yml");
  assert.deepEqual(rerun.on, { workflow_run: { workflows: ["Check"], types: ["completed"] } });
  assert.deepEqual(rerun.permissions, {});
  const job = rerun.jobs.rerun;
  // Only this repository's own first attempt: a fork's or a re-run's cancel never acts.
  assert.equal(
    job.if,
    "github.event.workflow_run.conclusion == 'cancelled' && " +
      "github.event.workflow_run.run_attempt == 1 && " +
      "github.event.workflow_run.head_repository.full_name == github.repository",
  );
  assert.deepEqual(job.permissions, { actions: "write", contents: "read" });
  const download = job.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("actions/download-artifact"),
  );
  assert.equal(download.with.name, "box-watch-verdict");
  assert.equal(download.with["run-id"], "${{ github.event.workflow_run.id }}");
  assert.equal(download["continue-on-error"], true);
  const run = job.steps.at(-1);
  assert.equal(run.run, "node scripts/ci/box-rerun.ts");
  assert.equal(run.env.RUN_ATTEMPT, "${{ github.event.workflow_run.run_attempt }}");
  assert.equal(run.env.BOX_LABEL, "${{ vars.BASALT_CI_BOX_LABEL }}");
});

test("the aggregate takes box-watch passed or skipped, never failed or cancelled", () => {
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...conditionalJobs].map((id) => [
      id,
      { result: conditionalJobs.includes(id) && id !== "workerd-assets" ? "skipped" : "success" },
    ]),
  );
  const box = ["declared-cloud-1"];
  for (const result of ["success", "skipped"])
    assert.deepEqual(
      gateErrors({ ...needs, "box-watch": { result } }, heavyJobs, box, true),
      [],
      result,
    );
  for (const result of ["failure", "cancelled"])
    assert.ok(
      gateErrors({ ...needs, "box-watch": { result } }, heavyJobs, box, true).some((error) =>
        error.startsWith("box-watch:"),
      ),
      result,
    );
  // A Check that routed nothing skips box-watch.
  assert.ok(
    gateErrors({ ...needs, "box-watch": { result: "skipped" } }, heavyJobs, [], true).every(
      (error) => !error.startsWith("box-watch:"),
    ),
  );
});
