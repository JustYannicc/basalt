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
import { parseVerdict, rerunDecision, retried, type RerunJob, type Run } from "./ci/box-rerun.ts";
import { declaredJobs, namedJobs } from "./ci/box-router.ts";

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
  // box-watch finds a box job by the name GitHub shows: a declared shard's own, a named job's id,
  // and a leg as `job (value)`, which GitHub shows only for a one-key matrix with no name of its
  // own. A job it can't find would hold the aggregate until box-watch gives up after 40 minutes.
  const workflow = read(".github/workflows/ci.yml");
  for (const [id, named] of Object.entries(namedJobs)) {
    const ci = workflow.jobs[id];
    assert.equal(ci.name, undefined, id);
    if (typeof named.minutes === "number") continue;
    for (const leg of ci.strategy.matrix.include) assert.equal(Object.keys(leg).length, 1, id);
  }
  for (const id of declaredJobs) assert.equal(workflow.jobs[id].name, "${{ matrix.shard }}", id);
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
  // Either wave: the latest start that still ends by the floor at the box's 2x pace, plus the
  // margin. A 4-minute job: 20 - 8 + 5 = 17; a 15-minute one: max(0, 20 - 30) + 5 = 5.
  const second: Planned = { minutes: 4, wave: 2 };
  assert.equal(latestStart(second, 20), 17);
  assert.equal(latestStart(first, 20), 5);
  // A job longer than the floor at that pace may still wait the margin: the fast lane's floor is
  // its own longest job.
  assert.equal(latestStart({ minutes: 15.6, wave: 1 }, 15.6), 5);
  const planned = { "job-1": first, "job-2": second };
  // Nothing of this Check runs on the box: every stuck job goes with the cancel at the first deadline.
  const both = [job({ id: 1 }), job({ id: 2 })];
  assert.deepEqual(watch(both, 4.9, 0, planned), { action: "wait" });
  const late = watch(both, 5, 0, planned);
  assert.ok(late.action === "cancel");
  assert.equal(late.verdict.reason, "held-past-deadline");
  assert.deepEqual(late.verdict.stuck, [1, 2]);
});

test("a job waiting behind this Check's own running box jobs is never cut off for holding", () => {
  // The box is working on this Check: the second wave waits behind it by design, however slow.
  const jobs = [job({ id: 1, status: "in_progress" }), job({ id: 2 })];
  const planned = { "job-1": first, "job-2": { minutes: 4, wave: 2 } as Planned };
  assert.deepEqual(watch(jobs, 60, 0, planned), { action: "wait" });
  // A box that is down still is: the down rule doesn't wait on the running jobs.
  assert.equal(watch(jobs, 60, 5, planned).action, "cancel");
});

test("each job's deadline counts from when GitHub queued it, not from select", () => {
  // The jobs a box job needs took ten minutes to get a hosted runner: its clock starts then.
  const queued = start + 10 * minute;
  const jobs = [job({ id: 1, status: "completed" }), job({ id: 2, createdAt: queued })];
  const planned = { "job-1": first, "job-2": { minutes: 4, wave: 2 } as Planned };
  assert.deepEqual(watch(jobs, 26.9, 0, planned), { action: "wait" });
  assert.equal(watch(jobs, 27, 0, planned).action, "cancel");
  // The verdict's time is the listing's, to the second.
  const cancel = watch(jobs, 27.0105, 0, planned);
  assert.ok(cancel.action === "cancel");
  assert.equal(cancel.verdict.at, new Date(start + 27 * minute).toISOString());
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
    JSON.stringify({ ...JSON.parse(verdict), at: "soon" }),
    JSON.stringify({ ...JSON.parse(verdict), at: undefined }),
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
  const held = jobs.map((j) =>
    j.id === 11 ? { ...j, runnerName: "box-3", startedAt: "2026-11-21T16:04:59Z" } : j,
  );
  assert.equal(decide(verdict, held).action, "none");
  // One the box took only after the verdict, in the seconds before the cancel landed, still counts.
  const tookLate = jobs.map((j) =>
    j.id === 11 ? { ...j, runnerName: "box-3", startedAt: "2026-11-21T16:05:10Z" } : j,
  );
  assert.deepEqual(decide(verdict, tookLate), { action: "rerun", stuck: [11, 12] });
  const ran = jobs.map((j) => (j.id === 12 ? { ...j, conclusion: "success" } : j));
  assert.equal(decide(verdict, ran).action, "none");
  // No box label configured: nothing is a box job.
  assert.equal(rerunDecision(run, verdict, jobs, "").action, "none");
});

test("a re-run never cancels a pull request's newer Check", () => {
  // The pull request's Checks share a group that cancels in progress.
  assert.deepEqual(rerunDecision(run, verdict, jobs, "basalt-box", true), {
    action: "none",
    why: "a newer Check runs for this pull request, and a re-run would cancel it",
  });
});

test("a box job lost with the box is no real failure; with the box up, it is", () => {
  const lost = [...jobs, boxJob(16, "declared-cloud-3")].map((j) =>
    j.id === 16
      ? { ...j, conclusion: "failure", runnerName: "box-3", startedAt: "2026-11-21T16:01:00Z" }
      : j,
  );
  assert.deepEqual(decide(verdict, lost), { action: "rerun", stuck: [11, 12] });
  const held = JSON.stringify({ ...JSON.parse(verdict), reason: "held-past-deadline" });
  assert.equal(decide(held, lost).action, "report");
});

test("box-rerun retries GitHub's passing failures and stops on a refusal", async () => {
  const answers = (...statuses: number[]) => {
    let call = 0;
    return () => Promise.resolve(new Response(null, { status: statuses[call++] }));
  };
  const noWait = async () => {};
  assert.equal((await retried(answers(502, 503, 200), "x", 3, noWait)).status, 200);
  await assert.rejects(retried(answers(404), "x", 3, noWait), /returned 404 for x/);
  await assert.rejects(retried(answers(502, 502, 502), "x", 3, noWait), /kept failing x: 502/);
  let thrown = 0;
  const dropped = () =>
    ++thrown < 3
      ? Promise.reject(new Error("socket hang up"))
      : Promise.resolve(new Response(null, { status: 204 }));
  assert.equal((await retried(dropped, "x", 3, noWait)).status, 204);
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
  assert.equal(run.env.RUN_EVENT, "${{ github.event.workflow_run.event }}");
  assert.equal(run.env.HEAD_BRANCH, "${{ github.event.workflow_run.head_branch }}");
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
