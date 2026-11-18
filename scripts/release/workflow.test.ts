import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const step = (name: string) => {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `missing step ${name}`);
  const next = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
};
const order = (...names: string[]) => names.map((name) => workflow.indexOf(`- name: ${name}`));

test("an automatic release starts only after main's own Check passed on a push from this repository", () => {
  assert.match(
    workflow,
    /^  workflow_run:\n    workflows: \[Check\]\n    types: \[completed\]\n    branches: \[main\]$/m,
  );
  for (const term of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
    "github.event.workflow_run.path == '.github/workflows/ci.yml'",
  ])
    assert.ok(workflow.includes(term), term);
});

test("the release hold stops every run except a dispatch carrying a coordinator GO", () => {
  const hold = step("Respect the release hold");
  assert.match(hold, /PRODUCTION_RELEASE_HOLD/u);
  assert.match(hold, /workflow_dispatch/u);
  assert.match(hold, /\^coordinator-20/u);
  assert.match(hold, /exit 1/u);
  const [first] = order("Respect the release hold");
  for (const later of order("Plan and check", "Apply the reviewed plan")) assert.ok(first! < later);
});

test("nothing applies before the load gate, the serving version, the backup and the counts", () => {
  const [gate, serving, backup, before, apply] = order(
    "Refuse while the pool database is busy",
    "Record the serving version of every Worker the plan updates",
    "Back up the pool database",
    "Count accounts and history before",
    "Apply the reviewed plan",
  );
  assert.ok(gate! < serving! && serving! < backup! && backup! < before! && before! < apply!);
  assert.match(
    step("Apply the reviewed plan"),
    /--plan-digest "\$PLAN_DIGEST" --attempt "\$ATTEMPT"/u,
  );
});

test("a failed apply or acceptance rolls PoolWorker back by itself and ends red", () => {
  const rollback = step("Roll back a failed release");
  assert.match(rollback, /always\(\)/u);
  assert.match(
    rollback,
    /steps\.apply\.outcome == 'failure' \|\| steps\.accept\.outcome == 'failure'/u,
  );
  assert.match(rollback, /rollback --stage production --from .local\/release\/serving.json/u);
  assert.match(rollback, /exit 1/u);
  assert.match(rollback, /POLICY_NAME != 'cutover-classes'/u);
  assert.match(step("Apply the reviewed plan"), /continue-on-error: true/u);
  assert.match(step("Accept the release through the live pool"), /continue-on-error: true/u);
});

test("the class change states what was verified first and never pretends it can roll back", () => {
  const verified = step("What was verified before the irreversible step");
  for (const item of [
    "plan digest",
    "wire-guard self-test",
    "PlanetScale backup",
    "database load",
    "counts",
    "serving version",
  ])
    assert.ok(verified.includes(item), item);
  const [summary, apply] = order(
    "What was verified before the irreversible step",
    "Apply the reviewed plan",
  );
  assert.ok(summary! < apply!);
  assert.match(step("Stop on a failed class change"), /cannot be rolled back/u);
});

test("every production attempt from the backup on leaves a GitHub Deployment with its outcome", async () => {
  const [record, backup] = order("Record the deployment", "Back up the pool database");
  assert.ok(record! < backup!);
  assert.match(step("Record the deployment"), /environment=production/u);
  assert.match(step("Record the deployment"), /override: \$override/u);
  const finish = step("Finish the deployment record");
  assert.match(finish, /always\(\)/u);
  assert.match(finish, /job\.status == 'success' && 'success' \|\| 'failure'/u);
  assert.match(workflow, /run-name: ".*override_reason.*Release \(override: \{0\}\)/u);
  assert.match(step("Stop the line and require a rehearsal"), /OVERRIDE_REASON/u);
});
