import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredSecrets } from "../environment.ts";
import { test } from "node:test";
import { exactMigrationRelease, migrationActivationInput } from "./migration-activation-gate.ts";

const environment = {
  BASALT_RELEASE_CANDIDATE: "a".repeat(40),
  MIGRATION_ACTIVATION_MODE: "plan",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "synthetic/basalt",
  GITHUB_WORKFLOW_REF: "synthetic/basalt/.github/workflows/release-main.yml@refs/heads/main",
};

test("the trusted activation gate imports before package dependencies are installed", () => {
  const gate = new URL("./migration-activation-gate.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { isBuiltin, registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isBuiltin(specifier) && !/^(?:\\.|\\/|file:)/u.test(specifier))
      throw new Error("Activation gate requires an uninstalled package: " + specifier);
    return nextResolve(specifier, context);
  }
});
await import(${JSON.stringify(gate)});`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("a successful containing release cannot substitute for the exact recorded candidate", () => {
  const candidate = environment.BASALT_RELEASE_CANDIDATE;
  assert.equal(
    exactMigrationRelease(candidate, { state: "ready", gitCommit: candidate, deploymentId: 42 }),
    42,
  );
  for (const ledger of [
    { state: "uninitialized" as const },
    { state: "unresolved" as const, gitCommit: candidate, deploymentId: 42 },
    { state: "ready" as const, gitCommit: "b".repeat(40), deploymentId: 43 },
    { state: "ready" as const, gitCommit: candidate, deploymentId: 0 },
  ])
    assert.throws(() => exactMigrationRelease(candidate, ledger), /wrong-production-candidate/);
});

test("only exact candidate plan, digest and inspect inputs enter the trusted activation job", () => {
  for (const mode of ["plan", "inspect", "b".repeat(64)])
    assert.deepEqual(
      migrationActivationInput({ ...environment, MIGRATION_ACTIVATION_MODE: mode }),
      {
        candidate: environment.BASALT_RELEASE_CANDIDATE,
        mode,
      },
    );
  for (const mode of ["", "apply", "Plan", "b".repeat(63), " b".repeat(32)])
    assert.throws(
      () => migrationActivationInput({ ...environment, MIGRATION_ACTIVATION_MODE: mode }),
      /mode-invalid/,
    );
  for (const candidate of ["", "main", "a".repeat(39), "a".repeat(40) + "\n"])
    assert.throws(
      () => migrationActivationInput({ ...environment, BASALT_RELEASE_CANDIDATE: candidate }),
      /candidate-required/,
    );
});

test("activation refuses PR, non-main and different workflow contexts before connecting", () => {
  for (const changed of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_WORKFLOW_REF: "synthetic/basalt/.github/workflows/other.yml@refs/heads/main" },
  ])
    assert.throws(
      () => migrationActivationInput({ ...environment, ...changed }),
      /trusted-workflow/,
    );
  assert.throws(
    () =>
      migrationActivationInput({ ...environment, BASALT_HOME_SCHEMA_RETRY_INTENT: "other-intent" }),
    /conflicting-input/,
  );
});

test("a production release hold refuses every activation input before connecting", () => {
  for (const mode of ["plan", "inspect", "b".repeat(64)]) {
    assert.throws(
      () =>
        migrationActivationInput({
          ...environment,
          MIGRATION_ACTIVATION_MODE: mode,
          PRODUCTION_RELEASE_HOLD: "restore in progress",
        }),
      /migration-activation-release-held.*PRODUCTION_RELEASE_HOLD/,
    );
    assert.doesNotThrow(() =>
      migrationActivationInput({
        ...environment,
        MIGRATION_ACTIVATION_MODE: mode,
        PRODUCTION_RELEASE_HOLD: "  ",
      }),
    );
  }
});

test("the activation workflow keeps the release lock and excludes all ordinary deployment work", () => {
  const require = createRequire(new URL("../architecture/package.json", import.meta.url));
  const { parse } = require("yaml");
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/release-main.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.concurrency, {
    group: "deploy-production",
    "cancel-in-progress": false,
  });
  assert.match(workflow.jobs.backup.if, /inputs\.migration_activation == ''/);
  assert.match(workflow.jobs.deploy.if, /inputs\.migration_activation == ''/);
  const job = workflow.jobs["migration-activation"];
  assert.equal(job.environment, "production-release");
  assert.match(job.if, /inputs\.migration_activation != ''/);
  assert.equal(job.needs, undefined);
  const steps = job.steps;
  assert.equal(steps[0].with.ref, "${{ github.sha }}");
  const conflict = steps.findIndex(
    (step: { name?: string }) => step.name === "Reject conflicting recovery operations",
  );
  assert.equal(steps[conflict].if, "inputs.runtime_abort != ''");
  assert.match(steps[conflict].run, /exit 1/);
  const validate = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("migration-activation-gate.ts"),
  );
  const select = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("git worktree add"),
  );
  const run = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("migration-activation-entry.ts"),
  );
  assert.ok(conflict > 0 && validate > conflict && select > validate && run > select);
  assert.equal(steps[run]["working-directory"], "${{ runner.temp }}/candidate");
  const commands = steps.map((step: { run?: string }) => step.run ?? "").join("\n");
  assert.doesNotMatch(
    commands,
    /already-live|main-candidate\.ts newest|release\.ts deploy|backup-only|--apply|--activate-change-journal/,
  );
  assert.doesNotMatch(commands, /\$\{\{ inputs\./);
  assert.equal(steps[run].env.MIGRATION_ACTIVATION_MODE, "${{ inputs.migration_activation }}");
  const artifact = steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(artifact.if, "always()");
  assert.match(artifact.with.path, /migration-activation\.json$/);
});

test("the activation workflow starts its candidate client with production deployment config", (context) => {
  const require = createRequire(new URL("../architecture/package.json", import.meta.url));
  const { parse } = require("yaml");
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/release-main.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs["migration-activation"].steps.find((step: { run?: string }) =>
    step.run?.includes("migration-activation-entry.ts"),
  );
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "basalt-activation-config-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const output = join(scratch, "config.json");
  const keys = [
    "BETTER_AUTH_URL",
    "ALCHEMY_STAGE",
    "PLANETSCALE_DATABASE_NAME",
    "PLANETSCALE_REGION",
    "PLANETSCALE_CLUSTER_SIZE",
    "CLOUD_SOURCE_NAMESPACE",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "TELEMETRY_RELAY_KEY",
    "BASALT_RELEASE_CANDIDATE",
    "BASALT_RELEASE_ATTEMPT",
    "MIGRATION_ACTIVATION_MODE",
    "BASALT_HOME_SCHEMA_RETRY_INTENT",
  ];
  const client = join(bin, "bun");
  writeFileSync(
    client,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.CONFIG_OUTPUT, JSON.stringify({
  args: process.argv.slice(2),
  env: Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]])),
}));
process.exit(Number(process.env.CONFIG_CLIENT_EXIT || 0));
`,
  );
  chmodSync(client, 0o700);
  const source = {
    ...Object.fromEntries(requiredSecrets.map((key) => [key, "fixture"])),
    AUTH_GITHUB_CLIENT_ID: "fixture-github-client-id",
    AUTH_GITHUB_CLIENT_SECRET: "fixture-github-client-secret",
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_DEPLOYMENT_KEY: "cd".repeat(32),
    ALCHEMY_STAGE: "production",
    BASALT_RELEASE_ATTEMPT: "stale-fixture-attempt",
    BASALT_HOME_SCHEMA_RETRY_INTENT: "",
    CONFIG_OUTPUT: output,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
  };
  const attempts = new Set<string>();
  for (const mode of ["plan", "inspect", "f".repeat(64)]) {
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
      cwd: root,
      env: { ...source, MIGRATION_ACTIVATION_MODE: mode },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(captured.args, ["scripts/release-barrier/migration-activation-entry.ts"]);
    assert.equal(captured.env.BETTER_AUTH_URL, "https://app.signalbox.run");
    assert.equal(captured.env.ALCHEMY_STAGE, "production");
    assert.equal(captured.env.PLANETSCALE_DATABASE_NAME, "basalt");
    assert.equal(captured.env.PLANETSCALE_REGION, "eu-central");
    assert.equal(captured.env.PLANETSCALE_CLUSTER_SIZE, "PS_5");
    assert.equal(captured.env.CLOUD_SOURCE_NAMESPACE, "basalt-production-apps");
    assert.equal(captured.env.GITHUB_CLIENT_ID, source.AUTH_GITHUB_CLIENT_ID);
    assert.equal(captured.env.GITHUB_CLIENT_SECRET, source.AUTH_GITHUB_CLIENT_SECRET);
    assert.match(captured.env.TELEMETRY_RELAY_KEY, /^[a-f0-9]{64}$/);
    assert.equal(
      captured.env.BASALT_RELEASE_CANDIDATE,
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    );
    assert.match(
      captured.env.BASALT_RELEASE_ATTEMPT,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    attempts.add(captured.env.BASALT_RELEASE_ATTEMPT);
    assert.equal(captured.env.MIGRATION_ACTIVATION_MODE, mode);
    assert.equal(captured.env.BASALT_HOME_SCHEMA_RETRY_INTENT, "");
  }
  assert.equal(attempts.size, 3);
  const failed = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
    cwd: root,
    env: { ...source, MIGRATION_ACTIVATION_MODE: "plan", CONFIG_CLIENT_EXIT: "17" },
    encoding: "utf8",
  });
  assert.notEqual(failed.status, 0);
});
