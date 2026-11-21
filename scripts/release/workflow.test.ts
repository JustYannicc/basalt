import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
/** The release job's steps as Actions reads them, with every YAML alias resolved. */
const parsedSteps = (
  parse(workflow) as {
    jobs: { release: { steps: { name?: string; run?: string; env?: object; with?: object }[] } };
  }
).jobs.release.steps;
const step = (name: string) => {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `missing step ${name}`);
  const next = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
};
const order = (...names: string[]) => names.map((name) => workflow.indexOf(`- name: ${name}`));
/** A step's exact `if:` condition, so a test fails when the condition is weakened, not only removed. */
const condition = (name: string) => /^\s+if: (.*)$/mu.exec(step(name))?.[1];
const job = (name: string) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing job ${name}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z-]+:\n/u);
  return workflow.slice(start, next < 0 ? undefined : start + 1 + next);
};

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
  assert.equal(
    condition("Roll back a failed release"),
    "always() && env.MODE == 'apply' && env.POLICY_NAME != 'cutover-classes' && env.POLICY_NAME != 'code-restart' && steps.serving.outcome == 'success' && (steps.apply.outcome == 'failure' || (steps.accept.outcome == 'failure' && steps.accept.outputs.acceptance != 'could-not-test'))",
  );
  assert.match(rollback, /rollback --stage production --from .local\/release\/serving.json/u);
  assert.match(rollback, /exit 1/u);
  assert.match(rollback, /POLICY_NAME != 'cutover-classes'/u);
  assert.match(step("Apply the reviewed plan"), /continue-on-error: true/u);
  assert.match(step("Accept the release through the live pool"), /continue-on-error: true/u);
});

test("an acceptance that could not test stops the run red without rolling back", () => {
  // The pool refused the acceptance device: nothing failed to serve, so nothing is undone.
  assert.equal(
    condition("Stop on an acceptance that could not test"),
    "always() && env.MODE == 'apply' && env.POLICY_NAME != 'cutover-classes' && env.POLICY_NAME != 'code-restart' && steps.accept.outputs.acceptance == 'could-not-test'",
  );
  const [rollback, counts, stop, record] = order(
    "Roll back a failed release",
    "Count accounts and history after",
    "Stop on an acceptance that could not test",
    "Finish the deployment record",
  );
  assert.ok(rollback! < stop!, "after the rollback it replaces");
  // The release stays live, so its counts still run before the stop, and its record says failure.
  assert.ok(counts! < stop! && stop! < record!, "after the counts, before the record");
  assert.match(
    step("Stop on an acceptance that could not test"),
    /::error::.*the release's acceptance device was refused: check that it is still registered and allowed[\s\S]*exit 1/u,
  );
});

test("release acceptance signs for a device named by a variable; no stored model key remains", () => {
  assert.doesNotMatch(workflow, /POOL_ACCEPTANCE_KEY/u);
  for (const name of [
    "Record the root's boot before the apply",
    "Accept the release through the live pool",
    "Roll back a failed release",
  ]) {
    const env = parsedSteps.find((entry) => entry.name === name)?.env as
      | Record<string, string>
      | undefined;
    assert.equal(env?.POOL_ACCEPTANCE_DEVICE, "${{ vars.POOL_ACCEPTANCE_DEVICE }}", name);
    assert.equal(env?.POOL_APP_SIGNING_KEY, "${{ secrets.POOL_APP_SIGNING_KEY }}", name);
    // Mid-rotation acceptance signs with the previous key, which both Workers accept.
    assert.equal(
      env?.POOL_APP_SIGNING_KEY_PREVIOUS,
      "${{ secrets.POOL_APP_SIGNING_KEY_PREVIOUS }}",
      name,
    );
  }
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
    "controller storage bookmark",
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

test("every run, plan-only included, passes the read-only preflight before planning", () => {
  const preflight = step("Preflight against State");
  assert.match(preflight, /deploy\.ts preflight --stage production/u);
  assert.doesNotMatch(preflight, /\bif:/u);
  const [first, plan] = order("Preflight against State", "Plan and check");
  assert.ok(first! < plan!);
  assert.match(step("Keep the retired layer's records, sealed"), /always\(\)/u);
});

test("a dispatch releases main only, and only the release job holds the production lock", () => {
  assert.match(
    job("candidate"),
    /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/u,
  );
  // On the workflow, a run whose jobs are all skipped would replace a pending release.
  assert.doesNotMatch(workflow, /^concurrency:/mu);
  assert.match(
    job("release"),
    /\n    concurrency:\n      group: deploy-production\n      cancel-in-progress: false\n/u,
  );
  // The job holding production's secrets states main's ref itself, where a guard reads it.
  assert.match(
    job("release"),
    /\n    if: github\.ref == 'refs\/heads\/main' && needs\.candidate\.outputs\.release == 'true'\n/u,
  );
});

test("an automatic run releases the newest passing main commit and skips one already live", () => {
  const pick = step("Pick the candidate");
  assert.match(pick, /main-candidate\.ts newer/u);
  assert.match(pick, /sha="\$\{newer:-\$CANDIDATE\}"/u);
  assert.match(pick, /deployments\?environment=production/u);
  assert.match(pick, /merge-base --is-ancestor "\$sha" "\$live"/u);
  assert.match(pick, /release=false/u);
  assert.match(
    job("release"),
    /BASALT_RELEASE_CANDIDATE: \$\{\{ needs\.candidate\.outputs\.sha \}\}/u,
  );
});

test("a dispatched apply applies exactly the reviewed plan, and every record names it", () => {
  assert.equal(
    condition("A dispatched apply names its reviewed plan"),
    "github.event_name == 'workflow_dispatch' && env.MODE == 'apply'",
  );
  assert.match(step("A dispatched apply names its reviewed plan"), /exit 1/u);
  const plan = step("Plan and check");
  assert.match(plan, /\$\{ATTEMPT_INPUT:\+--attempt "\$ATTEMPT_INPUT"\}/u);
  assert.match(plan, /"\$digest" != "\$PLAN_DIGEST_INPUT"[\s\S]*exit 1/u);
  assert.match(plan, /PLAN_DIGEST=%s\\nATTEMPT=%s\\n' "\$digest" "\$attempt" >> "\$GITHUB_ENV"/u);
  const apply = step("Apply the reviewed plan");
  assert.match(apply, /--plan-digest "\$PLAN_DIGEST" --attempt "\$ATTEMPT"/u);
  assert.doesNotMatch(apply, /inputs\.plan_digest/u);
  assert.match(step("Record the deployment"), /DIGEST: \$\{\{ steps\.plan\.outputs\.digest \}\}/u);
});

test("the stop-the-line gate names who triggered the run", () => {
  const gate = step("Stop the line and require a rehearsal");
  assert.match(gate, /TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/u);
  assert.match(gate, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(job("release"), /statuses: read/u);
});

test("every production entry call the workflow makes is one the entry accepts", () => {
  const calls = [...workflow.matchAll(/deploy\.ts (\w[\w-]*) --stage production([^\n]*)/gu)];
  assert.ok(calls.length >= 8, `found ${calls.length}`);
  for (const [line, command, rest] of calls) {
    assert.ok(
      [
        "preflight",
        "plan",
        "db-load",
        "serving",
        "backup",
        "snapshot",
        "boot",
        "apply",
        "accept",
        "rollback",
      ].includes(command!),
      line,
    );
    // The entry reads a policy only to plan or apply, and refuses those without one.
    if (command === "plan" || command === "apply")
      assert.match(rest!, /--policy "\$POLICY"/u, line);
  }
});

test("production secrets reach only the steps that run the entry", () => {
  const env = /\n    env:\n([\s\S]*?)\n    steps:/u.exec(job("release"))?.[1] ?? "";
  assert.doesNotMatch(env, /secrets\./u, "no secret in the job env");
  // Parsed, so a step that takes its env through any YAML alias counts too.
  const secretSteps = parsedSteps.filter((entry) =>
    JSON.stringify({ env: entry.env, run: entry.run, with: entry.with }).includes("secrets."),
  );
  for (const entry of secretSteps)
    assert.match(
      entry.run ?? "",
      /scripts\/release\/deploy\.ts |scripts\/pool-fleet\/dispatch\.ts|scripts\/pool-crash-dispatch\.ts/u,
      entry.name ?? "unnamed step",
    );
  const secretNames = secretSteps.map((entry) => entry.name);
  for (const name of [
    "Prepare",
    "Build and measure Worker startup",
    "Keep the plan and the counts",
  ]) {
    assert.ok(
      parsedSteps.some((entry) => entry.name === name),
      `missing step ${name}`,
    );
    assert.ok(!secretNames.includes(name), name);
  }
  assert.equal(secretSteps.length, 14);
});

test("the root pin's full reference, which carries the account, never enters the workflow", () => {
  const env = /\n    env:\n([\s\S]*?)\n    steps:/u.exec(job("release"))?.[1] ?? "";
  assert.match(env, /^      POOL_ROOT_PIN: \$\{\{ vars\.POOL_ROOT_PIN \}\}$/mu);
  // Not in the job env, a step env, GITHUB_ENV or an echo: the entry composes it in its process.
  assert.doesNotMatch(workflow, /POOL_ROOT_IMAGE/u);
});

test("acceptance covers the public app as well as the pool", () => {
  const accept = step("Accept the release through the live pool");
  const [pool, app] = [accept.indexOf("deploy.ts accept"), accept.indexOf("node scripts/smoke.ts")];
  assert.ok(pool >= 0 && app > pool);
});

test("the root's boot is read before the apply and must still serve after it", () => {
  const [boot, apply, accept] = order(
    "Record the root's boot before the apply",
    "Apply the reviewed plan",
    "Accept the release through the live pool",
  );
  assert.ok(boot! < apply! && apply! < accept!);
  assert.match(
    step("Record the root's boot before the apply"),
    /deploy\.ts boot --stage production --out \.local\/release\/root-boot\.json/u,
  );
  assert.match(
    step("Accept the release through the live pool"),
    /--root-boot \.local\/release\/root-boot\.json/u,
  );
  assert.match(
    step("Accept the release through the live pool"),
    /env\.POLICY_NAME == 'code' \|\| env\.POLICY_NAME == 'cutover-code'\) && 'same-boot'/u,
  );
});

test("the class change takes the controller storage bookmark first, under the same GO", () => {
  const bookmark = step("Take the controller storage bookmark");
  assert.equal(
    condition("Take the controller storage bookmark"),
    "env.MODE == 'apply' && env.POLICY_NAME == 'cutover-classes'",
  );
  assert.match(bookmark, /POOL_FLEET_MODE=bookmark POOL_FLEET_GO="\$GO_INPUT"/u);
  const [taken, verified, apply] = order(
    "Take the controller storage bookmark",
    "What was verified before the irreversible step",
    "Apply the reviewed plan",
  );
  assert.ok(taken! < verified! && verified! < apply!);
});

test("while the hold is set an automatic run is skipped, and a failed rollback is said out loud", () => {
  const pick = step("Pick the candidate");
  assert.match(pick, /PRODUCTION_RELEASE_HOLD: \$\{\{ vars\.PRODUCTION_RELEASE_HOLD \}\}/u);
  assert.match(pick, /if \[ -n "\$PRODUCTION_RELEASE_HOLD" \]; then[\s\S]*?release=false/u);
  const rollback = step("Roll back a failed release");
  assert.doesNotMatch(rollback, /\|\| true/u);
  assert.match(rollback, /::error::The rolled-back version also fails acceptance/u);
});

test("a dispatch can release an exact main commit, and only one that is on main", () => {
  const pick = step("Pick the candidate");
  assert.match(pick, /CANDIDATE_INPUT: \$\{\{ inputs\.candidate \}\}/u);
  assert.match(pick, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(pick, /git merge-base --is-ancestor "\$CANDIDATE_INPUT" "\$CANDIDATE"/u);
  assert.match(pick, /CANDIDATE="\$CANDIDATE_INPUT"/u);
});

test("a healing release waits for the root's new boot within its policy's bound, and is not rolled back", () => {
  assert.match(
    step("Record the root's boot before the apply"),
    /\$\{within:\+--allow-not-serving\}/u,
  );
  assert.match(
    step("Accept the release through the live pool"),
    /expect=\(--expect restart --serving \.local\/release\/serving\.json --apply "\$\{\{ steps\.apply\.outcome \}\}"\)/u,
  );
  assert.match(step("Accept the release through the live pool"), /acceptance\.rootRestart\.bound/u);
  // Acceptance only reads, so a failed healing apply is still accepted; every other policy is not.
  assert.equal(
    condition("Accept the release through the live pool"),
    "env.MODE == 'apply' && (steps.apply.outcome == 'success' || (env.POLICY_NAME == 'code-restart' && steps.apply.outcome == 'failure'))",
  );
  assert.equal(
    condition("Stop on a failed healing release"),
    "always() && env.MODE == 'apply' && env.POLICY_NAME == 'code-restart' && (steps.apply.outcome == 'failure' || steps.accept.outcome == 'failure')",
  );
  assert.match(step("Stop on a failed healing release"), /exit 1/u);
  assert.match(step("Roll back a failed release"), /exit 1/u);
});
