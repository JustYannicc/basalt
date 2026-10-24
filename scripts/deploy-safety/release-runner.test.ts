import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import { assertReleaseMode, executeRelease, type ReleaseDependencies } from "./release-runner.ts";

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

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
