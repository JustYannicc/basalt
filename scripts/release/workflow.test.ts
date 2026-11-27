import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
type Step = {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: object;
  with?: object;
};
const parsed = parse(workflow) as {
  on: { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } };
  jobs: {
    release: {
      env: Record<string, string>;
      concurrency: { group: string; "cancel-in-progress": boolean };
      environment: { name: string; deployment: boolean };
      steps: Step[];
    };
  };
};
/** The release job's steps as Actions reads them, with every YAML alias resolved. */
const parsedSteps = parsed.jobs.release.steps;
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

interface Context {
  readonly event: string;
  readonly env: Record<string, string>;
  readonly steps: Record<string, { outcome: string; outputs?: Record<string, string> }>;
  /** A step before this one failed: a condition without a status function then never runs. */
  readonly failed: boolean;
  /** Whether `hashFiles` finds the file a condition names. */
  readonly found: boolean;
}
// Every construct release.yml's conditions use; anything else fails rather than guessing.
const term =
  /\s+|[()]|&&|\|\||==|!=|!|'[\w-]*'|(?:always|success|failure|cancelled)\(\)|hashFiles\('[^']*'\)|github\.event_name|env\.\w+|steps\.[\w-]+\.(?:outcome|outputs\.[\w-]+)/uy;
/** A step's `if:` as Actions decides it, compiled once so a sweep over many contexts stays fast. */
const compile = (expression: string | undefined): ((context: Context) => boolean) => {
  const source = expression ?? "";
  for (term.lastIndex = 0; term.lastIndex < source.length;)
    assert.ok(term.exec(source), `unknown expression: ${source}`);
  const js = source
    .replace(/\bhashFiles\('[^']*'\)/gu, '(c.found ? "found" : "")')
    .replace(
      /\bsteps\.([\w-]+)\.outcome\b/gu,
      (_, id: string) => `(c.steps[${JSON.stringify(id)}]?.outcome ?? "skipped")`,
    )
    .replace(
      /\bsteps\.([\w-]+)\.outputs\.([\w-]+)/gu,
      (_, id: string, output: string) =>
        `(c.steps[${JSON.stringify(id)}]?.outputs?.[${JSON.stringify(output)}] ?? "")`,
    )
    .replace(/\bgithub\.event_name\b/gu, "c.event")
    .replace(/\benv\.(\w+)/gu, (_, name: string) => `(c.env[${JSON.stringify(name)}] ?? "")`)
    .replace(/\balways\(\)/gu, "true")
    .replace(/\bsuccess\(\)/gu, "!c.failed")
    .replace(/\bfailure\(\)/gu, "c.failed")
    .replace(/\bcancelled\(\)/gu, "false")
    .replaceAll("'", '"');
  // Without a status function, Actions runs the step only while nothing before it failed.
  const status = /\b(?:always|success|failure|cancelled)\(\)/u.test(source);
  const body = !source ? "!c.failed" : status ? js : `!c.failed && (${js})`;
  return runInNewContext(`(c) => Boolean(${body})`) as (context: Context) => boolean;
};
const label = (entry: Step) => entry.name ?? `uses ${entry.uses}`;
const repairSteps = [
  "A repair names one plain row, and its apply carries a coordinator GO",
  "Plan the State repair",
  "Apply the reviewed State repair",
];
const policies = ["release", "code", "code-restart", "cutover-code", "cutover-classes"];
/** Every combination of the inputs and step results the release job's conditions read. */
function* contexts(modes: string[], steps = true): Generator<Context> {
  const outcomes = steps ? ["success", "failure", "skipped"] : ["skipped"];
  for (const event of ["workflow_dispatch", "workflow_run"])
    for (const MODE of modes)
      for (const POLICY_NAME of policies)
        for (const PLAN_DIGEST_INPUT of ["", "digest"])
          for (const failed of [false, true])
            for (const found of [false, true])
              for (const provider of outcomes)
                for (const apply of outcomes)
                  for (const accept of outcomes)
                    for (const serving of outcomes)
                      for (const acceptance of steps ? ["", "could-not-test"] : [""])
                        for (const id of steps ? ["", "1"] : [""])
                          yield {
                            event,
                            env: { MODE, POLICY_NAME, PLAN_DIGEST_INPUT },
                            steps: {
                              provider: { outcome: provider },
                              apply: { outcome: apply },
                              accept: { outcome: accept, outputs: { acceptance } },
                              serving: { outcome: serving },
                              deployment: { outcome: id ? "success" : "skipped", outputs: { id } },
                            },
                            failed,
                            found,
                          };
}
/** Runs a step's script as Actions does (`bash -e`), with only the env it is given. */
const runStep = (name: string, env: Record<string, string>) => {
  const entry = parsedSteps.find((candidate) => candidate.name === name);
  assert.ok(entry?.run, `missing step ${name}`);
  return spawnSync("bash", ["-e", "-c", entry.run], {
    env: { PATH: process.env.PATH ?? "", ...(entry.env as Record<string, string>), ...env },
    encoding: "utf8",
  });
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
    /::error::.*the release's acceptance device hit its user's cap: check the cap[\s\S]*exit 1/u,
  );
});

test("release acceptance signs for a device named by a masked secret; no stored model key remains", () => {
  assert.doesNotMatch(workflow, /POOL_ACCEPTANCE_KEY/u);
  for (const name of [
    "Record the root's boot before the apply",
    "Accept the release through the live pool",
    "Roll back a failed release",
  ]) {
    const env = parsedSteps.find((entry) => entry.name === name)?.env as
      | Record<string, string>
      | undefined;
    // A secret, not a variable: GitHub prints a step's env in its log and masks only secrets.
    assert.equal(env?.POOL_ACCEPTANCE_DEVICE, "${{ secrets.POOL_ACCEPTANCE_DEVICE }}", name);
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

test("a plan runs the apply's read-only steps too, so an apply is never their first run", () => {
  // Only a State repair, which is no release, skips them.
  for (const name of [
    "Record the serving version of every Worker the plan updates",
    "Count accounts and history before",
    "Record the root's boot before the apply",
  ])
    assert.equal(condition(name), "env.MODE != 'repair'", name);
  // A plan proves the read; the full count stays with the policies that change data.
  assert.match(
    step("Count accounts and history before"),
    /\(env\.MODE == 'plan' \|\| [^}]*'--light'/u,
  );
  for (const name of [
    "Record the deployment",
    "Back up the pool database",
    "Read the provider observation again right before the apply",
    "Apply the reviewed plan",
    "Accept the release through the live pool",
  ])
    assert.match(condition(name) ?? "", /env\.MODE == 'apply'/u, name);
  // Every other step that carries production secrets writes, so it never runs in a plan.
  const reads = new Set([
    "Preflight against State",
    // Read-only: without a digest, the wire guard lets production see nothing but reads.
    "Plan the State repair",
    "Read the provider observation before a declared root restart",
    "Plan and check",
    "Record the serving version of every Worker the plan updates",
    "Count accounts and history before",
    "Record the root's boot before the apply",
  ]);
  const writes = parsedSteps.filter(
    (entry) =>
      !reads.has(entry.name ?? "") &&
      JSON.stringify({ env: entry.env, run: entry.run, with: entry.with }).includes("secrets."),
  );
  assert.ok(writes.length > 0);
  for (const entry of writes) {
    assert.match(entry.if ?? "", /env\.MODE == '(?:apply|repair)'/u, label(entry));
    const holds = compile(entry.if);
    for (const context of contexts(["plan"], false))
      assert.equal(holds(context), false, label(entry));
  }
  assert.match(step("Check the apply's tools are present"), /for tool in gh jq bun node; do/u);
  assert.match(step("Check the apply's tools are present"), /gh api rate_limit/u);
  assert.equal(condition("Check the apply's tools are present"), undefined);
  const [tools, prepare] = order("Check the apply's tools are present", "Prepare");
  assert.ok(tools! < prepare!);
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

test("every release run, plan-only included, passes the read-only preflight before planning", () => {
  const preflight = step("Preflight against State");
  assert.match(preflight, /deploy\.ts preflight --stage production/u);
  assert.equal(condition("Preflight against State"), "env.MODE != 'repair'");
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
        // The State repair; the entry on main gains it with that repair, and refuses it until then.
        "repair",
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
  assert.equal(secretSteps.length, 16);
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

test("a dispatch can run a State repair of one named row", () => {
  const { mode, fqn } = parsed.on.workflow_dispatch.inputs;
  assert.deepEqual(mode!.options, ["plan", "apply", "repair"]);
  assert.equal(mode!.default, "plan");
  assert.deepEqual(fqn, {
    description: "For repair, the container row a stopped apply left holding a placeholder",
    required: false,
    type: "string",
    default: "",
  });
});

test("a repair runs only the repair: no plan, apply, accept, rollback, snapshot or record step", () => {
  // What runs, by digest: the shared setup, the hold, then one repair step.
  const ran = (digest: string, failed: boolean) =>
    parsedSteps
      .filter((entry) =>
        compile(entry.if)({
          event: "workflow_dispatch",
          env: { MODE: "repair", POLICY_NAME: "code", PLAN_DIGEST_INPUT: digest },
          steps: {},
          failed,
          found: false,
        }),
      )
      .map(label);
  const setup = [
    "uses actions/checkout@v4",
    "A repair names one plain row, and its apply carries a coordinator GO",
    "Respect the release hold",
    "uses ./.github/actions/setup-node",
    "uses ./.github/actions/setup-bun",
    "Check the apply's tools are present",
    "Prepare",
    "Build and measure Worker startup",
  ];
  const kept = ["Keep the plan and the counts", "Keep the retired layer's records, sealed"];
  assert.deepEqual(ran("", false), [...setup, "Plan the State repair", ...kept]);
  assert.deepEqual(ran("digest", false), [...setup, "Apply the reviewed State repair", ...kept]);
  // A failed repair leaves only the artifact uploads, and no deployment record to finish.
  assert.deepEqual(ran("", true), kept);
  // Whatever any step reported, nothing but the repair calls the entry, a dispatcher or the
  // Deployments API. The deployment record is one of those, so it never leaves an id to finish.
  for (const entry of parsedSteps.filter(
    (candidate) =>
      !repairSteps.includes(candidate.name ?? "") &&
      /deploy\.ts |gh api "repos|dispatch\.ts/u.test(candidate.run ?? ""),
  )) {
    const holds = compile(entry.if);
    for (const context of contexts(["repair"]))
      if (!context.steps.deployment!.outputs!.id) assert.equal(holds(context), false, label(entry));
  }
});

test("the repair steps run only in repair mode: the plan without a digest, the apply with one", () => {
  for (const name of repairSteps) {
    const holds = compile(condition(name));
    for (const context of contexts(["plan", "apply"])) assert.equal(holds(context), false, name);
  }
  const plan = compile(condition("Plan the State repair"));
  const apply = compile(condition("Apply the reviewed State repair"));
  for (const context of contexts(["repair"], false)) {
    const digest = context.env.PLAN_DIGEST_INPUT !== "";
    assert.equal(plan(context), !digest && !context.failed);
    assert.equal(apply(context), digest && !context.failed);
  }
  assert.match(
    step("Plan the State repair"),
    /\n {10}bun scripts\/release\/deploy\.ts repair --stage production --fqn "\$FQN"\n/u,
  );
  assert.match(
    step("Apply the reviewed State repair"),
    /\n {10}bun scripts\/release\/deploy\.ts repair --stage production --fqn "\$FQN" --plan-digest "\$PLAN_DIGEST_INPUT"\n/u,
  );
  const preflight = parsedSteps.find((entry) => entry.name === "Preflight against State")!.env;
  for (const name of ["Plan the State repair", "Apply the reviewed State repair"])
    assert.deepEqual(parsedSteps.find((entry) => entry.name === name)!.env, preflight, name);
});

test("a repair's fqn reaches the entry only through the environment, checked before anything runs", () => {
  assert.equal(workflow.match(/inputs\.fqn/gu)?.length, 1);
  assert.equal(parsed.jobs.release.env.FQN, "${{ inputs.fqn }}");
  // Every use is a quoted shell variable; no expression puts the value into a script.
  assert.doesNotMatch(workflow, /(?<!")\$\{?FQN\b/u);
  for (const name of repairSteps)
    assert.doesNotMatch(parsedSteps.find((entry) => entry.name === name)!.run!, /\$\{\{/u, name);
  // The checkout must come first (the secrets guard), and the check straight after it.
  assert.equal(parsedSteps[0]!.uses, "actions/checkout@v4");
  assert.equal(parsedSteps[1]!.name, repairSteps[0]);
  assert.equal(condition(repairSteps[0]!), "env.MODE == 'repair'");
});

test("the repair check refuses an empty or malformed fqn, and an apply without a coordinator GO", () => {
  const check = (FQN: string, PLAN_DIGEST_INPUT = "", GO_INPUT = "") =>
    runStep(repairSteps[0]!, { FQN, PLAN_DIGEST_INPUT, GO_INPUT });
  for (const value of [
    "",
    "a b",
    "a;b",
    "$(id)",
    "a`id`",
    'a"b',
    "a\nb",
    "RouteGateway\n",
    "-x",
    ".x",
    "/x",
    "é",
    "::error::x",
    "x".repeat(129),
  ]) {
    const result = check(value);
    assert.equal(result.status, 1, JSON.stringify(value));
    assert.match(result.stdout, /^::error::/u, JSON.stringify(value));
    if (value) assert.ok(!result.stdout.includes(value), `printed ${JSON.stringify(value)}`);
  }
  for (const value of ["RouteGateway", "pool/route-gateway_1.v2", "_x", "x".repeat(128)])
    assert.equal(check(value).status, 0, check(value).stdout);
  // The apply writes production State, so it needs the GO even when the hold is unset.
  const go = "coordinator-2026-11-27T10:00Z";
  assert.equal(check("RouteGateway", "digest").status, 1);
  assert.equal(check("RouteGateway", "digest", "yes").status, 1);
  assert.equal(check("RouteGateway", "digest", go).status, 0);
  assert.equal(check("RouteGateway", "", "").status, 0, "a plan needs no GO beyond the hold's");
  // In the form the hold step takes it.
  const pattern = (name: string) => /grep -Eq '([^']+)'/u.exec(step(name))?.[1];
  assert.equal(pattern(repairSteps[0]!), pattern("Respect the release hold"));
});

test("a repair is a step of the release job: its production lock, environment and candidate", () => {
  const release = parsed.jobs.release;
  for (const name of repairSteps)
    assert.ok(
      release.steps.some((entry) => entry.name === name),
      name,
    );
  assert.deepEqual(release.concurrency, {
    group: "deploy-production",
    "cancel-in-progress": false,
  });
  // No GitHub Deployment from the environment either: a State repair deploys nothing.
  assert.deepEqual(release.environment, { name: "production-release", deployment: false });
  assert.equal(release.env.BASALT_RELEASE_CANDIDATE, "${{ needs.candidate.outputs.sha }}");
  assert.doesNotMatch(step("Plan the State repair"), /gh api|deployments/u);
  assert.doesNotMatch(step("Apply the reviewed State repair"), /gh api|deployments/u);
});

// Every release step's condition as plan and apply read it; a step not named here has none.
const releaseConditions: Record<string, string> = {
  "A dispatched apply names its reviewed plan":
    "github.event_name == 'workflow_dispatch' && env.MODE == 'apply'",
  "Stop the line and require a rehearsal": "hashFiles('scripts/guardrails/release-gate.ts') != ''",
  "Stop on an unread provider observation":
    "always() && env.MODE == 'plan' && steps.provider.outcome == 'failure'",
  "Refuse while the pool database is busy": "env.MODE == 'apply'",
  "Record the deployment": "env.MODE == 'apply'",
  "Back up the pool database": "env.MODE == 'apply'",
  "Take the controller storage bookmark":
    "env.MODE == 'apply' && env.POLICY_NAME == 'cutover-classes'",
  "What was verified before the irreversible step":
    "env.MODE == 'apply' && env.POLICY_NAME == 'cutover-classes'",
  "Read the provider observation again right before the apply": "env.MODE == 'apply'",
  "Apply the reviewed plan": "env.MODE == 'apply'",
  "Accept the release through the live pool":
    "env.MODE == 'apply' && (steps.apply.outcome == 'success' || (env.POLICY_NAME == 'code-restart' && steps.apply.outcome == 'failure'))",
  "Roll back a failed release":
    "always() && env.MODE == 'apply' && env.POLICY_NAME != 'cutover-classes' && env.POLICY_NAME != 'code-restart' && steps.serving.outcome == 'success' && (steps.apply.outcome == 'failure' || (steps.accept.outcome == 'failure' && steps.accept.outputs.acceptance != 'could-not-test'))",
  "Stop on a failed healing release":
    "always() && env.MODE == 'apply' && env.POLICY_NAME == 'code-restart' && (steps.apply.outcome == 'failure' || steps.accept.outcome == 'failure')",
  "Stop on a failed class change":
    "always() && env.MODE == 'apply' && env.POLICY_NAME == 'cutover-classes' && (steps.apply.outcome == 'failure' || steps.accept.outcome == 'failure')",
  "Count accounts and history after": "env.MODE == 'apply' && steps.apply.outcome == 'success'",
  "Stop on an acceptance that could not test":
    "always() && env.MODE == 'apply' && env.POLICY_NAME != 'cutover-classes' && env.POLICY_NAME != 'code-restart' && steps.accept.outputs.acceptance == 'could-not-test'",
  "Finish the deployment record": "always() && steps.deployment.outputs.id != ''",
  "Keep the plan and the counts": "always()",
  "Keep the retired layer's records, sealed": "always()",
};

test("a plan and an apply run every release step exactly as they would with no repair mode", () => {
  const names = new Set(parsedSteps.map((entry) => entry.name));
  for (const name of Object.keys(releaseConditions)) assert.ok(names.has(name), name);
  for (const entry of parsedSteps.filter(
    (candidate) => !repairSteps.includes(candidate.name ?? ""),
  )) {
    const now = compile(entry.if);
    const release = compile(releaseConditions[entry.name ?? ""]);
    for (const context of contexts(["plan", "apply"]))
      assert.equal(now(context), release(context), `${label(entry)}: ${JSON.stringify(context)}`);
  }
});
