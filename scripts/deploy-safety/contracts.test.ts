import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import {
  createBackupName,
  parseBackupName,
  parseClassificationReport,
  SafetyGateError,
  summarizePins,
} from "./contracts.ts";

const sha = (character: string) => character.repeat(40);

const pins: ReleasePins = {
  tools: { repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: sha("a") },
  home: {
    repository: "https://github.com/router-for-me/CLIProxyAPIHome.git",
    tag: "v1.2.3",
    commit: sha("b"),
    binary: "cli-proxy-api",
    assets: {
      amd64: { name: "home-linux-amd64.tar.gz", sha256: "c".repeat(64) },
      arm64: { name: "home-linux-arm64.tar.gz", sha256: "d".repeat(64) },
    },
  },
  node: {
    repository: "https://github.com/router-for-me/CLIProxyAPI.git",
    tag: "v4.5.6",
    commit: sha("e"),
    binary: "cli-proxy-api",
    assets: {
      amd64: { name: "node-linux-amd64.tar.gz", sha256: "f".repeat(64) },
      arm64: { name: "node-linux-arm64.tar.gz", sha256: "0".repeat(64) },
    },
  },
};

const evidence = (state: "unchanged" | "changed" | "unknown") => ({ state, sources: [] });

function report(overrides: Partial<ClassificationReport> = {}): ClassificationReport {
  const value: ClassificationReport = {
    schemaVersion: 1,
    base: { gitCommit: sha("1"), pins },
    candidate: {
      gitCommit: sha("2"),
      pins: { ...pins, tools: { ...pins.tools, commit: sha("3") } },
    },
    databaseChanged: true,
    workflowChanged: false,
    evidence: { database: evidence("unknown"), workflow: evidence("unchanged") },
  };
  return { ...value, ...overrides };
}

test("unknown database evidence stays database-changing and its rollback metadata is durable", () => {
  const candidate = report();
  const parsed = parseClassificationReport(candidate);
  assert.equal(parsed.databaseChanged, true);
  assert.equal(parsed.workflowChanged, false);

  const name = createBackupName(parsed, "main", "PS_5", true);
  const metadata = parseBackupName(name);
  assert.equal(metadata.base.gitCommit, sha("1"));
  assert.equal(metadata.candidate.gitCommit, sha("2"));
  assert.deepEqual(metadata.base.pins, summarizePins(pins));
  assert.equal(metadata.scope.branch, "main");
  assert.deepEqual(metadata.scope.logicalDatabases, ["postgres", "basalt_pool"]);
  assert.equal(metadata.branchContext.clusterSize, "PS_5");
  assert.equal(metadata.branchContext.hasReplicas, true);
});

test("classifier flag mismatch fails closed", () => {
  const candidate = report({ databaseChanged: false });
  assert.throws(() => parseClassificationReport(candidate), SafetyGateError);
});

test("malformed backup names fail closed", () => {
  assert.throws(() => parseBackupName("basalt-release-v1-not-valid"), SafetyGateError);
});
