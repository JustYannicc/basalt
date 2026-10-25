import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import { assertReleaseMode, executeManualRollback, executeRelease, type ManualRollbackDependencies, type ReleaseDependencies } from "./release-runner.ts";

const sha = (character: string) => character.repeat(40);

const pins: ReleasePins = {
  tools: { repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: sha("a") },
  home: {
    repository: "https://github.com/router-for-me/CLIProxyAPIHome.git",
    tag: "v1",
    commit: sha("b"),
    binary: "home",
    assets: { amd64: { name: "amd64", sha256: "c".repeat(64) }, arm64: { name: "arm64", sha256: "d".repeat(64) } },
  },
  node: {
    repository: "https://github.com/router-for-me/CLIProxyAPI.git",
    tag: "v1",
    commit: sha("e"),
    binary: "node",
    assets: { amd64: { name: "amd64", sha256: "f".repeat(64) }, arm64: { name: "arm64", sha256: "0".repeat(64) } },
  },
};

function report(overrides: Partial<ClassificationReport> = {}): ClassificationReport {
  return {
    schemaVersion: 1,
    base: { gitCommit: sha("1"), pins },
    candidate: { gitCommit: sha("2"), pins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: { database: { state: "unchanged", sources: [] }, workflow: { state: "unchanged", sources: [] } },
    ...overrides,
  };
}

function dependencies(overrides: Partial<ReleaseDependencies> = {}): ReleaseDependencies & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    validateCredentials: () => { calls.push("validate"); },
    assertBackup: async () => { calls.push("backup"); },
    begin: async () => { calls.push("begin"); return 7; },
    mark: async (_id, state) => { calls.push(`mark:${state}`); },
    deploy: async () => { calls.push("deploy"); return { started: true, exitCode: 0 }; },
    smoke: async () => { calls.push("smoke"); return { started: true, exitCode: 0 }; },
    rollback: async () => { calls.push("rollback"); },
    ...overrides,
  };
}

test("automatic release rejects either risk flag before setup or deployment", async () => {
  const deps = dependencies();
  await assert.rejects(executeRelease(report({ workflowChanged: true }), "automatic", deps), /require manual release mode/);
  assert.deepEqual(deps.calls, []);
  await assert.rejects(executeRelease(report({ databaseChanged: true }), "automatic", deps), /require manual release mode/);
  assert.deepEqual(deps.calls, []);
});

test("automatic release runs deploy, smoke and records success in order", async () => {
  const oldEvent = process.env.GITHUB_EVENT_NAME;
  const oldRef = process.env.GITHUB_REF;
  process.env.GITHUB_EVENT_NAME = "push";
  process.env.GITHUB_REF = "refs/heads/main";
  try {
    const deps = dependencies();
    const result = await executeRelease(report(), "automatic", deps);
    assert.deepEqual(deps.calls, ["validate", "begin", "deploy", "smoke", "mark:success"]);
    assert.deepEqual(result, { state: "deployed", deploymentId: 7 });
  } finally {
    restore("GITHUB_EVENT_NAME", oldEvent);
    restore("GITHUB_REF", oldRef);
  }
});

test("safe release deploy failure rolls back only after the deploy process started", async () => {
  const oldEvent = process.env.GITHUB_EVENT_NAME;
  const oldRef = process.env.GITHUB_REF;
  process.env.GITHUB_EVENT_NAME = "push";
  process.env.GITHUB_REF = "refs/heads/main";
  try {
    const deps = dependencies({ deploy: async () => { deps.calls.push("deploy"); return { started: true, exitCode: 1 }; } });
    await assert.rejects(executeRelease(report(), "automatic", deps), /previous safe release was redeployed successfully/);
    assert.deepEqual(deps.calls, ["validate", "begin", "deploy", "mark:failure", "rollback"]);

    const firstDeploy = dependencies({ deploy: async () => { firstDeploy.calls.push("deploy"); return { started: false, exitCode: null }; } });
    await assert.rejects(executeRelease(report(), "automatic", firstDeploy), /did not start; no rollback was attempted/);
    assert.deepEqual(firstDeploy.calls, ["validate", "begin", "deploy", "mark:failure"]);
  } finally {
    restore("GITHUB_EVENT_NAME", oldEvent);
    restore("GITHUB_REF", oldRef);
  }
});

test("initial release failure never redeploys the candidate as a pretend rollback", async () => {
  const oldEvent = process.env.GITHUB_EVENT_NAME;
  const oldRef = process.env.GITHUB_REF;
  process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  process.env.GITHUB_REF = "refs/heads/main";
  try {
    const deps = dependencies({ deploy: async () => { deps.calls.push("deploy"); return { started: true, exitCode: 1 }; } });
    await assert.rejects(executeRelease(report({ candidate: { gitCommit: sha("1"), pins } }), "automatic", deps), /Initial production deployment command failed/);
    assert.deepEqual(deps.calls, ["validate", "begin", "deploy", "mark:failure"]);
  } finally {
    restore("GITHUB_EVENT_NAME", oldEvent);
    restore("GITHUB_REF", oldRef);
  }
});

test("manual release failures do not trigger automatic rollback", async () => {
  const oldEvent = process.env.GITHUB_EVENT_NAME;
  const oldRef = process.env.GITHUB_REF;
  process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  process.env.GITHUB_REF = "refs/heads/main";
  try {
    const deps = dependencies({ deploy: async () => { deps.calls.push("deploy"); return { started: true, exitCode: 1 }; } });
    await assert.rejects(executeRelease(report({ databaseChanged: true }), "manual", deps), /manual rollback path/);
    assert.deepEqual(deps.calls, ["validate", "backup", "begin", "deploy", "mark:failure"]);
  } finally {
    restore("GITHUB_EVENT_NAME", oldEvent);
    restore("GITHUB_REF", oldRef);
  }
});

test("manual mode requires a trusted main workflow dispatch", () => {
  assert.throws(() => assertReleaseMode(report({ workflowChanged: true }), "manual", "push", "refs/heads/main"), /workflow_dispatch/);
  assert.throws(() => assertReleaseMode(report({ workflowChanged: true }), "manual", "workflow_dispatch", "refs/pull/12/merge"), /trusted main/);
  assert.doesNotThrow(() => assertReleaseMode(report({ workflowChanged: true }), "manual", "workflow_dispatch", "refs/heads/main"));
  assert.doesNotThrow(() => assertReleaseMode(report(), "automatic", "workflow_dispatch", "refs/heads/main"));
  assert.throws(() => assertReleaseMode(report({ databaseChanged: true }), "automatic", "workflow_dispatch", "refs/heads/main"), /require manual release mode/);
  assert.throws(() => assertReleaseMode(report(), "automatic", "push", "refs/heads/release"), /main branch/);
});

test("automatic mode accepts only main's Deploy workflow on workflow_run", () => {
  const deployRef = "owner/basalt/.github/workflows/deploy.yml@refs/heads/main";
  assert.doesNotThrow(() => assertReleaseMode(report(), "automatic", "workflow_run", "refs/heads/main", deployRef, "owner/basalt"));
  assert.throws(() => assertReleaseMode(report(), "automatic", "workflow_run", "refs/heads/main", "owner/basalt/.github/workflows/other.yml@refs/heads/main", "owner/basalt"), /main Deploy workflow/);
  assert.throws(() => assertReleaseMode(report(), "automatic", "workflow_run", "refs/heads/main", "owner/basalt/.github/workflows/deploy.yml@refs/heads/feature", "owner/basalt"), /main Deploy workflow/);
  assert.throws(() => assertReleaseMode(report(), "automatic", "workflow_run", "refs/heads/main", deployRef, "fork/basalt"), /main Deploy workflow/);
  assert.throws(() => assertReleaseMode(report(), "automatic", "workflow_run", "refs/heads/main", deployRef, ""), /main Deploy workflow/);
  assert.throws(() => assertReleaseMode(report(), "automatic", "workflow_run", "refs/heads/release", deployRef, "owner/basalt"), /main Deploy workflow/);
  assert.throws(() => assertReleaseMode(report({ databaseChanged: true }), "automatic", "workflow_run", "refs/heads/main", deployRef, "owner/basalt"), /require manual release mode/);
});

test("manual database rollback builds the exact old source, deploys it, smokes production and completes the ledger", async () => {
  const calls: string[] = [];
  const deps: ManualRollbackDependencies = {
    assertBackup: async () => { calls.push("backup"); },
    prepare: async () => { calls.push("prepare-and-build-old-source"); },
    validateCredentials: () => { calls.push("validate-old-source-and-credentials"); },
    begin: async (_value, expectedDeploymentId) => { calls.push(`begin:${expectedDeploymentId}`); return 99; },
    mark: async (id, state) => { calls.push(`mark:${id}:${state}`); },
    deploy: async () => { calls.push("deploy-old-source"); return { started: true, exitCode: 0 }; },
    smoke: async () => { calls.push("public-smoke"); return { started: true, exitCode: 0 }; },
  };
  const result = await executeManualRollback(
    report({ databaseChanged: true }), 42, deps, "workflow_dispatch", "refs/heads/main",
    "owner/repo/.github/workflows/release-rollback.yml@refs/heads/main", "owner/repo",
  );
  assert.deepEqual(calls, [
    "backup", "prepare-and-build-old-source", "validate-old-source-and-credentials", "begin:42",
    "deploy-old-source", "public-smoke", "mark:99:success",
  ]);
  assert.deepEqual(result, { state: "rolled-back", deploymentId: 99 });
});

test("manual rollback does not create a ledger record when prior-source preparation fails", async () => {
  const calls: string[] = [];
  const deps: ManualRollbackDependencies = {
    assertBackup: async () => { calls.push("backup"); },
    prepare: async () => { calls.push("prepare"); throw new Error("build failed"); },
    validateCredentials: () => { calls.push("validate"); },
    begin: async () => { calls.push("begin"); return 99; },
    mark: async () => { calls.push("mark"); },
    deploy: async () => { calls.push("deploy"); return { started: true, exitCode: 0 }; },
    smoke: async () => { calls.push("smoke"); return { started: true, exitCode: 0 }; },
  };
  await assert.rejects(
    executeManualRollback(
      report({ databaseChanged: true }), 42, deps, "workflow_dispatch", "refs/heads/main",
      "owner/repo/.github/workflows/release-rollback.yml@refs/heads/main", "owner/repo",
    ),
    /build failed/,
  );
  assert.deepEqual(calls, ["backup", "prepare"]);
});

test("manual rollback records deployment or smoke failure and requires trusted main dispatch", async () => {
  const calls: string[] = [];
  const deps: ManualRollbackDependencies = {
    assertBackup: async () => { calls.push("backup"); },
    prepare: async () => { calls.push("prepare"); },
    validateCredentials: () => { calls.push("validate"); },
    begin: async () => { calls.push("begin"); return 99; },
    mark: async (_id, state) => { calls.push(`mark:${state}`); },
    deploy: async () => { calls.push("deploy"); return { started: true, exitCode: 1 }; },
    smoke: async () => { calls.push("smoke"); return { started: true, exitCode: 0 }; },
  };
  await assert.rejects(executeManualRollback(
    report({ databaseChanged: true }), 42, deps, "workflow_dispatch", "refs/heads/main",
    "owner/repo/.github/workflows/release-rollback.yml@refs/heads/main", "owner/repo",
  ), /deployment failed/);
  assert.deepEqual(calls, ["backup", "prepare", "validate", "begin", "deploy", "mark:failure"]);

  calls.length = 0;
  deps.deploy = async () => { calls.push("deploy"); return { started: true, exitCode: 0 }; };
  deps.smoke = async () => { calls.push("smoke"); return { started: true, exitCode: 1 }; };
  await assert.rejects(executeManualRollback(
    report({ databaseChanged: true }), 42, deps, "workflow_dispatch", "refs/heads/main",
    "owner/repo/.github/workflows/release-rollback.yml@refs/heads/main", "owner/repo",
  ), /public smoke failed/);
  assert.deepEqual(calls, ["backup", "prepare", "validate", "begin", "deploy", "smoke", "mark:failure"]);

  calls.length = 0;
  await assert.rejects(executeManualRollback(
    report({ databaseChanged: true }), 42, deps, "push", "refs/heads/main",
    "owner/repo/.github/workflows/release-rollback.yml@refs/heads/main", "owner/repo",
  ), /trusted main/);
  assert.deepEqual(calls, []);
  await assert.rejects(executeManualRollback(
    report({ databaseChanged: true }), 42, deps, "workflow_dispatch", "refs/heads/main",
    "owner/repo/.github/workflows/release-manual.yml@refs/heads/main", "owner/repo",
  ), /trusted main/);
  assert.deepEqual(calls, []);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
