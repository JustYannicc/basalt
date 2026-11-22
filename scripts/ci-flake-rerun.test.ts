import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { flakeDecision, parseJobFlakes, type JobFlake } from "./ci/flake-rerun.ts";
import { flakeNote, flakeRunTitle } from "./ci/flake-note.ts";
import { parsePolicy } from "./ci/flake-policy.ts";
import { attemptJobs, supersededPullRequest, type Run, type RunJob } from "./ci/workflow-run.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const listed = JSON.parse(
  readFileSync(new URL("./ci/tracked-flakes.json", import.meta.url), "utf8"),
) as unknown[];

const flake: JobFlake = {
  id: "go-race",
  job: "pool-runtime",
  match: ["--- FAIL: TestRace ", "FAIL\tgithub.com/example/pkg"],
  only: { marker: "--- FAIL: ", allow: "--- FAIL: TestRace " },
  issue: 1656,
  listed: "2026-11-22",
  expires: "2026-12-22",
};
const run: Run = { id: 7, attempt: 1, conclusion: "failure" };
const today = "2026-11-22";
const flaky =
  "\u001b[31m--- FAIL: TestRace (0.00s)\u001b[39m\nFAIL\tgithub.com/example/pkg\t10.6s\n";
const jobs: RunJob[] = [
  { id: 1, name: "pool-runtime (compatibility)", conclusion: "failure" },
  { id: 2, name: "fast", conclusion: "success" },
  // The aggregate fails whenever a job does; it is never a job to re-run.
  { id: 3, name: "check", conclusion: "failure" },
];
const decide = (
  list: RunJob[] = jobs,
  logs = new Map([[1, flaky]]),
  at = run,
  flakes = [flake],
  day = today,
) => flakeDecision(at, list, logs, flakes, day);

test("a job is re-run only when its log carries a listed flake's whole signature", () => {
  assert.deepEqual(decide(), {
    action: "rerun",
    jobs: [{ id: 1, name: "pool-runtime (compatibility)", flake }],
    note: "Re-ran pool-runtime (compatibility) for listed flake go-race (#1656, until 22-12-2026)",
  });
  // Half the signature, or none of it, is a failure for a person.
  for (const log of ["--- FAIL: TestRace (0.00s)", "panic: other", ""])
    assert.equal(decide(jobs, new Map([[1, log]])).action, "report", log);
  // The listed failure beside another of its kind is no flake: a new failing test stays red.
  for (const extra of ["--- FAIL: TestFoo (0.01s)", "--- FAIL: TestRaceDetector (0.00s)"])
    assert.equal(decide(jobs, new Map([[1, flaky + extra + "\n"]])).action, "report", extra);
  // A declared job's shards match its id.
  const shard = { ...flake, job: "declared-cloud" };
  const shardJobs = [{ id: 1, name: "declared-cloud-7", conclusion: "failure" }, jobs[2]!];
  assert.equal(decide(shardJobs, undefined, run, [shard]).action, "rerun");
  assert.equal(
    decide([{ ...shardJobs[0]!, name: "declared-cloud-extra" }, jobs[2]!], undefined, run, [shard])
      .action,
    "report",
  );
  // A flake listed for another job explains nothing here; a leg matches its job's id only.
  for (const name of ["pool-runtime-extra", "upstream-image"])
    assert.equal(decide([{ ...jobs[0]!, name }, jobs[2]!]).action, "report", name);
});

test("a listed flake matches from the day it was listed until its expiry date", () => {
  assert.equal(decide(jobs, undefined, run, [flake], "2026-12-22").action, "rerun");
  assert.equal(decide(jobs, undefined, run, [flake], "2026-12-23").action, "report");
  assert.equal(decide(jobs, undefined, run, [flake], "2026-11-21").action, "report");
});

test("any failure no listed flake explains leaves the whole run red for a person", () => {
  const other = [...jobs, { id: 4, name: "declared-cloud-3", conclusion: "failure" }];
  const decision = decide(
    other,
    new Map([
      [1, flaky],
      [4, "AssertionError: real"],
    ]),
  );
  assert.equal(decision.action, "report");
  assert.match((decision as { why: string }).why, /^declared-cloud-3 failed with no listed flake/);
});

test("once, from the first attempt, never over a newer Check, and only for a failed run", () => {
  assert.equal(decide(jobs, undefined, { ...run, attempt: 2 }).action, "none");
  for (const conclusion of ["success", "cancelled", null])
    assert.equal(
      decide(jobs, undefined, { ...run, conclusion }).action,
      "none",
      String(conclusion),
    );
  assert.equal(
    flakeDecision(run, jobs, new Map([[1, flaky]]), [flake], today, true).action,
    "none",
  );
  // Only the aggregate failed: nothing to re-run.
  assert.equal(decide([jobs[1]!, jobs[2]!]).action, "none");
});

test("several flaky jobs re-run together; a cancelled or timed-out job leaves the run for a person", () => {
  const two = [...jobs, { id: 5, name: "pool-runtime (current)", conclusion: "failure" }];
  const logs = new Map([
    [1, flaky],
    [5, flaky],
  ]);
  const both = decide(two, logs);
  assert.ok(both.action === "rerun");
  assert.deepEqual(
    both.jobs.map((job) => job.id),
    [1, 5],
  );
  // No flake explains a cancelled or timed-out job, and re-running failed jobs would re-run it; a
  // lone flaky job re-run beside it would fail the aggregate again.
  for (const conclusion of ["cancelled", "timed_out", "action_required"]) {
    const other = { id: 6, name: "account-usage", conclusion };
    assert.equal(decide([...two, other], logs).action, "report", conclusion);
    assert.equal(decide([...jobs, other]).action, "report", conclusion);
  }
  // A job name with control characters could write past its line into the outputs.
  assert.equal(
    decide([{ ...jobs[0]!, name: "pool-runtime (x)\nnote=y" }, jobs[2]!]).action,
    "none",
  );
  // Many legs: the note names the flakes, not every job.
  const legs = Array.from({ length: 9 }, (_, n) => ({
    id: 10 + n,
    name: `pool-runtime (leg-${n}-with-a-long-name)`,
    conclusion: "failure",
  }));
  const many = decide([...legs, jobs[2]!], new Map(legs.map((leg) => [leg.id, flaky])));
  assert.ok(many.action === "rerun");
  assert.equal(many.note, "Re-ran 9 jobs for listed flakes go-race (#1656, until 22-12-2026)");
});

test("every listed job flake names its issue, a signature and an expiry; test-scoped entries stay in-job", () => {
  const flakes = parseJobFlakes(listed);
  assert.deepEqual(
    flakes.map((entry) => [entry.id, entry.job, entry.issue]),
    [
      ["cpa-websocket-429-test", "pool-runtime", 1656],
      ["zoho-mcp-browser-assertions", "catalog-compat", 1625],
      ["production-ops-cleanup-502", "production-ops-identity", 1657],
    ],
  );
  const ci = read(".github/workflows/ci.yml");
  for (const entry of flakes) assert.ok(ci.jobs[entry.job], entry.id);
  // The in-job retry policy reads only its own entries from the same file.
  assert.ok(parsePolicy(listed).every((entry) => !flakes.some((job) => job.id === entry.id)));
  const base = {
    id: "x-y",
    scope: "job",
    job: "fast",
    match: ["a signature line"],
    only: { marker: "FAIL ", allow: "FAIL the listed one" },
    issue: 1,
    listed: "2026-11-22",
    expires: "2026-12-01",
  };
  assert.equal(parseJobFlakes([base]).length, 1);
  for (const broken of [
    { issue: undefined },
    { issue: 0 },
    { expires: "01-12-2026" },
    { expires: undefined },
    { match: [] },
    { match: ["short"] },
    { match: ["a signature\nline"] },
    { job: "Fast" },
    { only: undefined },
    { only: { marker: "FAIL ", allow: "short" } },
    { listed: undefined },
    // No flake lives there forever: at most 90 days from listing, and never before it.
    { expires: "2027-02-21" },
    { expires: "2026-11-21" },
  ])
    assert.throws(() => parseJobFlakes([{ ...base, ...broken }]), JSON.stringify(broken));
  assert.throws(() => parseJobFlakes([base, base]), /twice/);
});

test("the re-run attempt's summary names the flake flake-rerun.yml re-ran", () => {
  const runs = [
    { id: 20, display_title: flakeRunTitle(8), html_url: "https://example/20" },
    { id: 21, display_title: flakeRunTitle(7), html_url: "https://example/21" },
  ];
  const jobsOf = (id: number) =>
    id === 21
      ? [
          { name: "decide", conclusion: "success" },
          {
            name: "Re-ran pool-runtime (compatibility) for listed flake go-race (#1656, until 22-12-2026)",
            conclusion: "success",
          },
        ]
      : [{ name: "Re-ran other", conclusion: "success" }];
  assert.equal(
    flakeNote(7, runs, jobsOf),
    "This attempt is a machine re-run. Re-ran pool-runtime (compatibility) for listed flake go-race (#1656, until 22-12-2026); decided in https://example/21.",
  );
  // A person's re-run has no flake-rerun.yml run, or one that re-ran nothing.
  assert.equal(flakeNote(9, runs, jobsOf), undefined);
  assert.equal(
    flakeNote(7, runs, () => [{ name: "decide", conclusion: "success" }]),
    undefined,
  );
});

test("flake-rerun.yml decides read-only from the default branch, and only its re-run job may write", () => {
  const workflow = read(".github/workflows/flake-rerun.yml");
  assert.deepEqual(workflow.on, { workflow_run: { workflows: ["Check"], types: ["completed"] } });
  assert.equal(
    workflow["run-name"],
    "Flake re-run for Check run ${{ github.event.workflow_run.id }}",
  );
  assert.deepEqual(workflow.permissions, {});
  const { decide: decideJob, rerun } = workflow.jobs;
  assert.equal(
    decideJob.if,
    "github.event.workflow_run.conclusion == 'failure' && " +
      "github.event.workflow_run.run_attempt == 1 && " +
      "github.event.workflow_run.head_repository.full_name == github.repository",
  );
  assert.deepEqual(decideJob.permissions, { actions: "read", contents: "read" });
  assert.equal(decideJob.steps.at(-1).run, "node scripts/ci/flake-rerun.ts");
  assert.equal(rerun.name, "${{ needs.decide.outputs.note }}");
  assert.equal(rerun.if, "needs.decide.outputs.action == 'rerun'");
  assert.deepEqual(rerun.permissions, { actions: "write", "pull-requests": "read" });
  // The run's state is read again right before the POST: decide may be minutes old, and a re-run of
  // this workflow keeps the old event.
  const post = rerun.steps.at(-1).run as string;
  assert.ok(post.indexOf('"1 completed"') < post.indexOf("-X POST"));
  assert.ok(post.indexOf("HEAD_SHA") < post.indexOf("-X POST"));
  // The writing job checks out nothing, so no repository code runs with its token.
  assert.ok(rerun.steps.every((step: { uses?: string }) => !step.uses));
  const check = read(".github/workflows/ci.yml").jobs.check;
  const note = check.steps.find(
    (step: { run?: string }) => step.run === "node scripts/ci/flake-note.ts",
  );
  assert.equal(
    note.if,
    "always() && github.run_attempt == 2 && github.triggering_actor == 'github-actions[bot]'",
  );
  assert.equal(note["continue-on-error"], true);
});

test("the shared reads count only this repository's newer Checks and never decide on part of a run", async () => {
  const stub = (body: unknown) =>
    ({ call: async () => new Response(), json: async () => body }) as never;
  const env = { RUN_EVENT: "pull_request", HEAD_BRANCH: "fix/x", GITHUB_REPOSITORY: "owner/repo" };
  const runs = (repository: string, id = 8) => ({
    workflow_runs: [{ id, head_repository: { full_name: repository } }],
  });
  assert.equal(await supersededPullRequest(stub(runs("owner/repo")), run, env), true);
  // A fork's pull request on the same branch name, or an older run, supersedes nothing.
  assert.equal(await supersededPullRequest(stub(runs("fork/repo")), run, env), false);
  assert.equal(await supersededPullRequest(stub(runs("owner/repo", 6)), run, env), false);
  assert.equal(
    await supersededPullRequest(stub(runs("owner/repo")), run, { ...env, RUN_EVENT: "push" }),
    false,
  );
  const listed = { total_count: 2, jobs: [{ id: 1, name: "fast", conclusion: "failure" }] };
  await assert.rejects(attemptJobs(stub(listed), run), /read 1 of the run's 2 jobs/);
});
