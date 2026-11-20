import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as Output from "alchemy/Output";
import { Cause, Effect, Exit, Redacted } from "effect";
import { failureReport } from "./public-report.ts";
import {
  buildSteps,
  everyReleaseSteps,
  ReleaseStepFailed,
  runReleaseStep,
} from "./release-steps.ts";

/** A plan node as Alchemy hands it: the declaration's props, and the row the last apply recorded. */
const node = (
  action: string,
  props: Record<string, unknown>,
  recorded: Record<string, unknown> = props,
  type = "Command.Exec",
) => ({ action, resource: { Type: type, Props: props }, state: { props: recorded } });
const plan = (resources: Record<string, unknown>) =>
  ({ resources, deletions: {} }) as unknown as Parameters<typeof everyReleaseSteps>[0];

test("a noop every-release command runs before apply, with its env from the declaration or State", async () => {
  const branch = Output.literal("unresolved");
  const token = Redacted.make("synthetic-token");
  const steps = await Effect.runPromise(
    everyReleaseSteps(
      plan({
        PreviewPoolSize: node(
          "noop",
          {
            command: "node scripts/database-pool-budget.ts",
            cwd: "/checkout/.upstream/apps/hosted/cloud",
            env: { POOL_BUDGET_DATABASE: "basalt-preview-rehearsal-1", POOL_BUDGET_BRANCH: branch },
            timeout: "7 minutes",
          },
          {
            command: "node scripts/database-pool-budget.ts",
            cwd: "/elsewhere",
            env: { POOL_BUDGET_DATABASE: "old", POOL_BUDGET_BRANCH: "test-rehearsal-1-pool" },
          },
        ),
        AppSourceNamespace: node("noop", {
          command: "node ensure-artifacts.ts",
          cwd: "/checkout/scripts",
          env: {
            CLOUD_SOURCE_NAMESPACE: "basalt-preview-rehearsal-1-apps",
            CLOUDFLARE_API_TOKEN: token,
          },
        }),
        // Runs in the apply itself, and other commands are not every-release checks.
        Migrations: node("update", { command: "node scripts/database-pool-budget.ts", cwd: "/x" }),
        Seed: node("noop", { command: "node seed.ts", cwd: "/x" }),
      }),
    ),
  );
  assert.deepEqual(steps, [
    {
      fqn: "PreviewPoolSize",
      kind: "check",
      command: "node scripts/database-pool-budget.ts",
      cwd: "/checkout/.upstream/apps/hosted/cloud",
      env: {
        POOL_BUDGET_DATABASE: "basalt-preview-rehearsal-1",
        POOL_BUDGET_BRANCH: "test-rehearsal-1-pool",
      },
      secrets: {},
      timeoutMs: 420_000,
    },
    {
      fqn: "AppSourceNamespace",
      kind: "check",
      command: "node ensure-artifacts.ts",
      cwd: "/checkout/scripts",
      env: { CLOUD_SOURCE_NAMESPACE: "basalt-preview-rehearsal-1-apps" },
      secrets: { CLOUDFLARE_API_TOKEN: token },
      timeoutMs: 600_000,
    },
  ]);
  // A step is printed into logs; its secrets stay redacted there.
  assert.doesNotMatch(JSON.stringify(steps), /synthetic-token/u);
});

test("a value known neither from the declaration nor from State refuses the check", async () => {
  const exit = await Effect.runPromiseExit(
    everyReleaseSteps(
      plan({
        PreviewPoolSize: node(
          "noop",
          {
            command: "node scripts/database-pool-budget.ts",
            cwd: "/x",
            env: { POOL_BUDGET_BRANCH: Output.literal("x") },
          },
          { env: {} },
        ),
      }),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.squash(exit.cause);
  assert.ok(error instanceof ReleaseStepFailed);
  assert.equal(error.check, "PreviewPoolSize");
  assert.match(error.why, /POOL_BUDGET_BRANCH/u);
});

test("a failing check stops with its id and exit in public, and both streams only in private", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "release-step-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(
    join(directory, "scripts", "database-pool-budget.ts"),
    'console.log("PoolBudgetFailed: parameters read 404 at https://pool.example.internal"); console.error("on stderr"); process.exit(3);\n',
  );
  const step = {
    fqn: "RuntimeDatabaseBudget",
    kind: "check" as const,
    command: "node scripts/database-pool-budget.ts",
    cwd: directory,
    env: { STEP_VISIBLE: "yes" },
    secrets: { STEP_SECRET: Redacted.make("passed-through") },
    timeoutMs: 30_000,
  };
  const exit = await Effect.runPromiseExit(runReleaseStep(step));
  assert.ok(Exit.isFailure(exit));
  const error = Cause.squash(exit.cause) as ReleaseStepFailed;
  assert.equal(error.exit, "exit 3");
  assert.match(error.detail.stdout, /PoolBudgetFailed/u);
  assert.match(error.detail.stderr, /on stderr/u);
  const report = failureReport(error);
  assert.match(report.publicText, /ReleaseStepFailed: check=RuntimeDatabaseBudget exit=exit 3/u);
  assert.doesNotMatch(report.publicText, /pool\.example\.internal|PoolBudgetFailed/u);
  assert.match(report.detail, /PoolBudgetFailed/u);
  // The child gets its env and secrets as the stack's own command would.
  await writeFile(
    join(directory, "scripts", "database-pool-budget.ts"),
    'process.exit(process.env.STEP_VISIBLE === "yes" && process.env.STEP_SECRET === "passed-through" ? 0 : 4);\n',
  );
  assert.ok(Exit.isSuccess(await Effect.runPromiseExit(runReleaseStep(step))));
});

test("a build the plan updates runs before the checked plan; one it never recorded is the apply's", async () => {
  const site = {
    command: "bun run site:build",
    cwd: "../../..",
    outdir: "site",
    env: { ORIGIN: "x" },
  };
  const steps = await Effect.runPromise(
    buildSteps(
      plan({
        // Its output is missing in a fresh job, so Alchemy plans it as changed.
        Site: node("update", site, site, "Command.Build"),
        Built: node("noop", site, site, "Command.Build"),
        Fresh: { ...node("create", site, site, "Command.Build"), state: undefined },
        Migrations: node("update", { command: "node src/migrate.ts", cwd: "/x" }),
      }),
    ),
  );
  assert.deepEqual(
    steps.map(({ fqn, kind, command, cwd, env }) => ({ fqn, kind, command, cwd, env })),
    [
      {
        fqn: "Site",
        kind: "build",
        command: "bun run site:build",
        cwd: "../../..",
        env: { ORIGIN: "x" },
      },
    ],
  );
});

test("a failed build stops before anything is planned, saying so", async () => {
  const exit = await Effect.runPromiseExit(
    runReleaseStep({
      fqn: "Site",
      kind: "build",
      command: "node -e process.exit(2)",
      cwd: tmpdir(),
      env: {},
      secrets: {},
      timeoutMs: 30_000,
    }),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.squash(exit.cause) as ReleaseStepFailed;
  assert.equal(error.exit, "exit 2");
  assert.match(error.why, /build the plan depends on/u);
});
