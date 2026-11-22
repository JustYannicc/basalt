import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { flakeDecision, parseJobFlakes, type JobFlake } from "./ci/flake-rerun.ts";
import { flakeNote, flakeRunTitle } from "./ci/flake-note.ts";
import { parsePolicy } from "./ci/flake-policy.ts";
import type { Run, RunJob } from "./ci/workflow-run.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const listed = JSON.parse(
  readFileSync(new URL("./ci/tracked-flakes.json", import.meta.url), "utf8"),
) as unknown[];

const flake: JobFlake = {
  id: "go-race",
  job: "pool-runtime",
  match: ["--- FAIL: TestRace", "FAIL\tgithub.com/example/pkg"],
  issue: 1656,
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
  // A flake listed for another job explains nothing here; a leg matches its job's id only.
  for (const name of ["pool-runtime-extra", "upstream-image"])
    assert.equal(decide([{ ...jobs[0]!, name }, jobs[2]!]).action, "report", name);
});

test("a listed flake stops matching after its expiry date", () => {
  assert.equal(decide(jobs, undefined, run, [flake], "2026-12-22").action, "rerun");
  assert.equal(decide(jobs, undefined, run, [flake], "2026-12-23").action, "report");
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

test("several flaky jobs re-run together only when no other job was cancelled", () => {
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
  // Re-running failed jobs re-runs cancelled ones too, which no flake explains.
  const cut = [...two, { id: 6, name: "account-usage", conclusion: "cancelled" }];
  assert.equal(decide(cut, logs).action, "report");
  // One flaky job re-runs alone, whatever else was cancelled.
  assert.equal(decide([...jobs, cut.at(-1)!]).action, "rerun");
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
  for (const entry of flakes) {
    assert.ok(ci.jobs[entry.job], entry.id);
    assert.ok(entry.expires > "2026-11-22" && entry.expires <= "2027-02-22", entry.id);
  }
  // The in-job retry policy reads only its own entries from the same file.
  assert.ok(parsePolicy(listed).every((entry) => !flakes.some((job) => job.id === entry.id)));
  const base = {
    id: "x-y",
    scope: "job",
    job: "fast",
    match: ["a signature line"],
    issue: 1,
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
    { job: "Fast" },
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
  assert.deepEqual(rerun.permissions, { actions: "write" });
  // The writing job checks out nothing, so no repository code runs with its token.
  assert.ok(rerun.steps.every((step: { uses?: string }) => !step.uses));
  const check = read(".github/workflows/ci.yml").jobs.check;
  const note = check.steps.find(
    (step: { run?: string }) => step.run === "node scripts/ci/flake-note.ts",
  );
  assert.equal(note.if, "always() && github.run_attempt > 1");
  assert.equal(note["continue-on-error"], true);
});
