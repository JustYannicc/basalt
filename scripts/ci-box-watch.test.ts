import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { conditionalJobs, fastJobs, gateErrors, longJobs } from "./ci/gate.ts";
import { heavyJobs } from "./ci/areas.ts";
import { downMinutes, holdingMinutes, watchDecision, type WatchedJob } from "./ci/box-watch.ts";
import { parseVerdict, rerunDecision } from "./ci/box-rerun.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const minute = 60_000;
const start = Date.parse("2026-11-21T16:00:00Z");
const job = (fields: Partial<WatchedJob> & { id: number }): WatchedJob => ({
  name: `job-${fields.id}`,
  status: "queued",
  createdAt: new Date(start).toISOString(),
  onBox: true,
  ...fields,
});
const watch = (jobs: WatchedJob[], at: number, boxUp: boolean, floorMinutes = 20) =>
  watchDecision({
    jobs,
    boxUp,
    now: start + at * minute,
    selectedAt: start,
    floorMinutes,
    run: 7,
    attempt: 1,
    self: "box-watch",
  });

test("box-watch is done once every box job has started, whatever runs hosted", () => {
  const jobs = [
    job({ id: 1, status: "in_progress" }),
    job({ id: 2, status: "completed" }),
    job({ id: 3, onBox: false }),
  ];
  for (const boxUp of [true, false]) assert.deepEqual(watch(jobs, 60, boxUp), { action: "done" });
});

test("a box that is down for the bound gets its queued jobs cancelled for GitHub; before it, they wait", () => {
  const jobs = [
    job({ id: 1 }),
    job({ id: 2, status: "in_progress", onBox: false }),
    job({ id: 3, name: "box-watch", status: "in_progress", onBox: false }),
  ];
  assert.equal(downMinutes, 5);
  assert.deepEqual(watch(jobs, downMinutes - 0.5, false), { action: "wait" });
  const cancel = watch(jobs, downMinutes, false);
  assert.equal(cancel.action, "cancel");
  assert.ok(cancel.action === "cancel");
  assert.deepEqual(cancel.verdict, {
    run: 7,
    attempt: 1,
    reason: "box-down",
    stuck: [1],
    // Jobs its cancel cuts off, never box-watch itself.
    cutOff: [2],
    at: new Date(start + downMinutes * minute).toISOString(),
  });
});

test("a healthy box may hold a waiting job until the floor plus the margin, not past it", () => {
  const jobs = [job({ id: 1, status: "in_progress" }), job({ id: 2 })];
  assert.equal(holdingMinutes, 5);
  // Up and holding: no down cancel, however long the job has queued, until the floor's margin.
  assert.deepEqual(watch(jobs, 24.5, true), { action: "wait" });
  const late = watch(jobs, 25, true);
  assert.ok(late.action === "cancel");
  assert.equal(late.verdict.reason, "held-past-floor");
  assert.deepEqual(late.verdict.stuck, [2]);
});

const run = { id: 7, attempt: 1, conclusion: "cancelled" };
const verdict = JSON.stringify({
  run: 7,
  attempt: 1,
  reason: "box-down",
  stuck: [11, 12],
  cutOff: [13],
  at: "2026-11-21T16:05:00Z",
});
const jobs = [
  { id: 11, name: "declared-cloud-1", conclusion: "cancelled" },
  { id: 12, name: "declared-cloud-2", conclusion: "cancelled" },
  { id: 13, name: "fast", conclusion: "cancelled" },
  { id: 14, name: "client-mobile", conclusion: "success" },
];

test("box-rerun acts only on box-watch's own verdict for that very run and attempt", () => {
  // A Check a person cancelled, or a superseded run force-cancelled: no verdict, nothing happens.
  assert.equal(rerunDecision(run, undefined, jobs).action, "none");
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
    assert.equal(rerunDecision(run, text, jobs).action, "none", text);
  // A run that finished on its own is never re-run by this workflow.
  for (const conclusion of ["success", "failure", null])
    assert.equal(rerunDecision({ ...run, conclusion }, verdict, jobs).action, "none");
  assert.deepEqual(parseVerdict(verdict)?.stuck, [11, 12]);
});

test("with no real failure the stuck and cut-off jobs are re-run; a real failure leaves the run for a person", () => {
  assert.deepEqual(rerunDecision(run, verdict, jobs), { action: "rerun", stuck: [11, 12] });
  const failed = [...jobs, { id: 15, name: "pool-runtime", conclusion: "failure" }];
  assert.deepEqual(rerunDecision(run, verdict, failed), {
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
  assert.ok(workflow.jobs.check.needs.includes("box-watch"));
  assert.ok(longJobs.includes("box-watch"));
  assert.ok(conditionalJobs.includes("box-watch"));
});

test("box-rerun runs the default branch's file after a cancelled Check, with nothing but its script", () => {
  const rerun = read(".github/workflows/box-rerun.yml");
  assert.deepEqual(rerun.on, { workflow_run: { workflows: ["Check"], types: ["completed"] } });
  assert.deepEqual(rerun.permissions, {});
  const job = rerun.jobs.rerun;
  assert.equal(job.if, "github.event.workflow_run.conclusion == 'cancelled'");
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
