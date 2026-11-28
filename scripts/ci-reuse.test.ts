import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { decideReuse, type ReuseGet } from "./ci/reuse.ts";
import { reuseGateErrors, fastJobs, conditionalJobs, startJobs } from "./ci/gate.ts";
import { heavyJobs } from "./ci/areas.ts";

const context = {
  repository: "fixture/repository",
  head: "a".repeat(40),
  tree: "b".repeat(40),
  workflowBlob: "c".repeat(40),
  event: "push",
  ref: "refs/heads/main",
};
const run = {
  id: 123,
  workflow_id: 10,
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  event: "push",
  head_branch: "batch/b90",
  head_sha: "d".repeat(40),
  repository: { full_name: context.repository },
  head_repository: { full_name: context.repository },
};
const api =
  (changes: { run?: object; tree?: string; blob?: string; fail?: boolean } = {}): ReuseGet =>
  async (path) => {
    if (changes.fail) throw new Error("API unavailable");
    if (path === "/actions/workflows/ci.yml") return { id: 10, path: run.path };
    if (path.startsWith("/actions/workflows/ci.yml/runs?"))
      return { workflow_runs: [{ ...run, ...changes.run }] };
    if (path === `/git/commits/${run.head_sha}`)
      return { sha: run.head_sha, tree: { sha: changes.tree ?? context.tree } };
    if (path === `/contents/${run.path}?ref=${run.head_sha}`)
      return { type: "file", sha: changes.blob ?? context.workflowBlob };
    throw new Error(`Unexpected API path: ${path}`);
  };

test("an identical tree and workflow from a successful completed batch push are reusable", async () => {
  const decision = await decideReuse(context, api());
  assert.equal(decision.reused, true);
  if (!decision.reused) return;
  assert.equal(decision.evidence.runId, run.id);
  assert.equal(decision.evidence.headSha, run.head_sha);
  assert.equal(decision.evidence.head, context.head);
});

for (const [name, changes] of [
  ["tree mismatch", { tree: "e".repeat(40) }],
  ["workflow mismatch", { blob: "e".repeat(40) }],
  ["failed run", { run: { conclusion: "failure" } }],
  ["cancelled run", { run: { conclusion: "cancelled" } }],
  ["partial run", { run: { status: "in_progress" } }],
  ["non-batch branch", { run: { head_branch: "main" } }],
  ["PR event", { run: { event: "pull_request" } }],
  ["another workflow", { run: { workflow_id: 11 } }],
  ["another workflow file", { run: { path: ".github/workflows/other.yml" } }],
  ["another repository", { run: { repository: { full_name: "other/repository" } } }],
  ["fork head", { run: { head_repository: { full_name: "other/repository" } } }],
  ["API failure", { fail: true }],
] as const)
  test(`${name} runs the full Check`, async () => {
    assert.equal((await decideReuse(context, api(changes))).reused, false);
  });

test("batch and PR Checks never look up reuse", async () => {
  for (const candidate of [
    { ...context, event: "pull_request" },
    { ...context, ref: "refs/heads/batch/b90" },
  ]) {
    let called = false;
    assert.equal(
      (
        await decideReuse(candidate, async () => {
          called = true;
          throw new Error();
        })
      ).reused,
      false,
    );
    assert.equal(called, false);
  }
});

test("missing, malformed and failed commit or workflow reads run the full Check", async () => {
  for (const missing of [
    "/actions/workflows/ci.yml",
    "/actions/workflows/ci.yml/runs?",
    "/git/commits/",
    "/contents/",
  ]) {
    for (const fails of [false, true]) {
      const get: ReuseGet = (path) => {
        if (path.startsWith(missing)) {
          if (fails) throw new Error("API failure");
          return Promise.resolve({});
        }
        return api()(path);
      };
      assert.equal((await decideReuse(context, get)).reused, false);
    }
  }
});

// select decides the reuse; the jobs that start beside it run in every Check.
const ran = ["select", "cpa-pipeline", ...startJobs];
const reuseNeeds = () =>
  Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...conditionalJobs].map((job) => [
      job,
      { result: ran.includes(job) ? "success" : "skipped" },
    ]),
  );

test("the aggregate accepts only candidate-bound evidence and the main history guard and skipped suite jobs", async () => {
  const decision = await decideReuse(context, api());
  assert.ok(decision.reused);
  const errors = (
    evidence: unknown,
    needs = reuseNeeds(),
    event = "push",
    ref = "refs/heads/main",
  ) => reuseGateErrors(needs, evidence, context, event, ref);
  assert.deepEqual(errors(decision.evidence), []);
  for (const job of ran)
    assert.ok(
      errors(decision.evidence, { ...reuseNeeds(), [job]: { result: "skipped" } }).some((error) =>
        error.startsWith(job + ":"),
      ),
      job,
    );
  // A reused Check skips long-started, so every job waiting for selection must skip too.
  for (const job of ["long-started", "pool-runtime", "client-connection"])
    assert.ok(errors(decision.evidence, { ...reuseNeeds(), [job]: { result: "success" } }).length);
  // select decides reuse itself; a separate reuse job is no longer part of the Check.
  assert.ok(
    errors(decision.evidence, { ...reuseNeeds(), reuse: { result: "success" } }).includes(
      "Aggregate gate dependencies differ from the declared CI jobs",
    ),
  );
  for (const evidence of [
    null,
    {},
    { ...decision.evidence, head: run.head_sha },
    { ...decision.evidence, tree: "e".repeat(40) },
    { ...decision.evidence, workflowBlob: "e".repeat(40) },
    { ...decision.evidence, runId: undefined },
    { ...decision.evidence, headSha: undefined },
  ])
    assert.ok(errors(evidence).length);
  for (const job of Object.keys(reuseNeeds())) {
    assert.ok(errors(decision.evidence, { ...reuseNeeds(), [job]: { result: "failure" } }).length);
  }
  assert.ok(errors(decision.evidence, reuseNeeds(), "pull_request").length);
  assert.ok(errors(decision.evidence, reuseNeeds(), "push", "refs/heads/batch/b90").length);
});

test("the real aggregate CLI retains reusable run outputs and refuses missing evidence", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const git = (ref: string) =>
    execFileSync("git", ["rev-parse", ref], { cwd: root, encoding: "utf8" }).trim();
  const identity = {
    ...context,
    head: git("HEAD"),
    tree: git("HEAD^{tree}"),
    workflowBlob: git("HEAD:.github/workflows/ci.yml"),
  };
  const decision = await decideReuse(
    identity,
    api({ tree: identity.tree, blob: identity.workflowBlob }),
  );
  assert.ok(decision.reused);
  const directory = mkdtempSync(join(tmpdir(), "check-reuse-"));
  const output = join(directory, "output");
  const summary = join(directory, "summary");
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: context.repository,
    GITHUB_SHA: identity.head,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    CI_REUSED: "true",
    CI_NEEDS: JSON.stringify(reuseNeeds()),
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
  };
  try {
    const cli = fileURLToPath(new URL("./ci/gate.ts", import.meta.url));
    const execute = (evidence: unknown) =>
      spawnSync(process.execPath, [cli], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, CI_REUSE_EVIDENCE: JSON.stringify(evidence) },
      });
    const passed = execute(decision.evidence);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(readFileSync(output, "utf8"), /reused_run_id=123\n/);
    assert.match(readFileSync(output, "utf8"), new RegExp(`reused_head_sha=${run.head_sha}`));
    assert.match(readFileSync(summary, "utf8"), /actions\/runs\/123/);
    const refused = execute(null);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Invalid batch Check reuse evidence/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(join(root, "check-reuse-evidence.json"), { force: true });
  }
});

test("workflow skips every suite job only through the verified reuse decision", () => {
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const select = workflow.jobs.select;
  assert.equal(workflow.jobs.reuse, undefined);
  assert.equal(select.needs, undefined);
  assert.equal(select.if, undefined);
  assert.equal(select.permissions.actions, "write");
  // select decides reuse before anything else, and selects nothing once a batch Check stands in.
  const steps = select.steps as { id?: string; run?: string; if?: string; uses?: string }[];
  const decision = steps.findIndex((step) => step.id === "reuse");
  assert.equal(steps[decision]!.run, "node scripts/ci/reuse.ts");
  assert.deepEqual(
    steps.slice(0, decision).map((step) => step.uses),
    ["actions/checkout@v4", "./.github/actions/setup-node"],
  );
  // The light lane's label is the one exception: it selects nothing and holds on a reused Check.
  assert.equal(steps[decision + 1]!.id, "light");
  assert.equal(steps[decision + 1]!.if, undefined);
  for (const step of steps.slice(decision + 2))
    assert.equal(step.if, "steps.reuse.outputs.reused != 'true'", step.id ?? step.uses ?? "");
  for (const output of ["reused", "evidence", "run_id", "head_sha"])
    assert.equal(select.outputs[output], `\${{ steps.reuse.outputs.${output} }}`, output);
  // Only a reused Check gets the empty selection; any other one without a selection fails.
  assert.equal(
    select.outputs.jobs,
    "${{ steps.reuse.outputs.reused == 'true' && '[]' || steps.jobs.outputs.jobs }}",
  );
  for (const [name, job] of Object.entries(workflow.jobs) as [
    string,
    { needs?: string | string[]; if?: string },
  ][]) {
    if (["select", "check", ...startJobs].includes(name)) continue;
    assert.ok([job.needs].flat().includes("select"), `${name} must depend on selection`);
    // Long-tier jobs skip on a reused Check's empty selection, the rest with long-started.
    if (![job.needs].flat().includes("long-started") && name !== "cpa-pipeline")
      assert.match(job.if ?? "", /needs\.select\.outputs\.(?:jobs|box_jobs|reused)\b/, name);
  }
  assert.equal(workflow.jobs["long-started"].if, "needs.select.outputs.reused != 'true'");
  assert.equal(workflow.jobs["cpa-pipeline"].needs, "select");
  assert.equal(workflow.jobs["cpa-pipeline"].if, undefined);
  const gate = workflow.jobs.check.steps.find(
    (step: { run?: string }) => step.run === "node scripts/ci/gate.ts",
  );
  assert.equal(gate.env.CI_REUSED, "${{ needs.select.outputs.reused }}");
  assert.equal(gate.env.CI_REUSE_EVIDENCE, "${{ needs.select.outputs.evidence }}");
  assert.equal(
    workflow.jobs.check.outputs.reused_run_id,
    "${{ steps.gate.outputs.reused_run_id }}",
  );
});
