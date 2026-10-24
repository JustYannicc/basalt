import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import {
  assertManualRollbackCandidate,
  assertReportUsesLatestDeploy,
  deploymentPayloadFor,
  type DeploymentLedger,
} from "./github-ledger.ts";
import { summarizePins } from "./contracts.ts";
import { manualRollbackBaselineCommit } from "./release-plan.ts";

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
    assets: { amd64: { name: "amd64", sha256: "f".repeat(64) }, arm64: { name: "node-arm64", sha256: "0".repeat(64) } },
  },
};

function report(baseCommit = sha("1")): ClassificationReport {
  return {
    schemaVersion: 1,
    base: { gitCommit: baseCommit, pins },
    candidate: { gitCommit: sha("2"), pins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: { database: { state: "unchanged", sources: [] }, workflow: { state: "unchanged", sources: [] } },
  };
}

function readyLedger(value: ClassificationReport): Extract<DeploymentLedger, { state: "ready" }> {
  return {
    state: "ready",
    deploymentId: 8,
    gitCommit: value.candidate.gitCommit,
    pins: summarizePins(value.candidate.pins),
    payload: deploymentPayloadFor(value),
  };
}

test("manual rollback baseline comes from the recorded release payload when the release succeeded", () => {
  const value = report();
  const ledger = readyLedger(value);
  assert.equal(manualRollbackBaselineCommit(ledger), value.base.gitCommit);
  assert.doesNotThrow(() => assertManualRollbackCandidate(value, ledger));
});

test("initial successful release cannot use itself as a rollback baseline", () => {
  const value = report(sha("2"));
  const ledger = readyLedger(value);
  assert.throws(() => assertManualRollbackCandidate(value, ledger), /no prior successful production baseline/);
  assert.throws(() => manualRollbackBaselineCommit(ledger), /no prior successful production baseline/);
});

test("failed release rollback uses and verifies the last successful ledger baseline", () => {
  const value = report();
  const ledger: Extract<DeploymentLedger, { state: "unresolved" }> = {
    state: "unresolved",
    deploymentId: 8,
    gitCommit: value.candidate.gitCommit,
    deploymentStatus: "failure",
    reason: "deployment failed",
    lastSuccessful: { deploymentId: 7, gitCommit: value.base.gitCommit, pins: summarizePins(value.base.pins) },
    payload: deploymentPayloadFor(value),
  };
  assert.equal(manualRollbackBaselineCommit(ledger), value.base.gitCommit);
  assert.doesNotThrow(() => assertManualRollbackCandidate(value, ledger));
  assert.throws(() => assertReportUsesLatestDeploy(value, ledger), /Latest production deployment is unresolved/);
  assert.throws(() => manualRollbackBaselineCommit({ ...ledger, deploymentStatus: "in_progress" }), /completed production release/);
});

test("rollback is blocked when the latest release payload records a different baseline", () => {
  const value = report();
  const ledger = readyLedger(value);
  ledger.payload.basePins = { ...ledger.payload.basePins, tools: { commit: sha("3") } };
  assert.throws(() => assertManualRollbackCandidate(value, ledger), /recorded release baseline/);
});
