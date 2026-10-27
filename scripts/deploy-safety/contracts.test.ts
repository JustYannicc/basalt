import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import {
  backupNameFor,
  createBackupMetadata,
  createBackupName,
  MAXIMUM_BACKUP_NAME_LENGTH,
  parseClassificationReport,
  readBackupName,
  SafetyGateError,
  stableStringify,
  summarizePins,
  verifyBackupMetadata,
  type BackupMetadata,
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
  // The payload stores the metadata as JSON next to the name; reading it back must verify against the digest.
  const stored = JSON.parse(JSON.stringify(createBackupMetadata(parsed, "main", "PS_5", true)));
  const metadata = verifyBackupMetadata(name, stored);
  assert.equal(metadata.base.gitCommit, sha("1"));
  assert.equal(metadata.candidate.gitCommit, sha("2"));
  assert.deepEqual(metadata.base.pins, summarizePins(pins));
  assert.equal(metadata.scope.branch, "main");
  assert.deepEqual(metadata.scope.logicalDatabases, ["postgres", "basalt_pool"]);
  assert.equal(metadata.branchContext.clusterSize, "PS_5");
  assert.equal(metadata.branchContext.hasReplicas, true);
  assert.equal(backupNameFor(metadata), name);
});

// Shaped like the base fa2a131 -> candidate e38e9e4 release whose 880-character v1 name PlanetScale rejected.
const releasedPins: ReleasePins = {
  tools: { repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: "f69c667936e4c02c75f9d7cc79fb750c230839b9" },
  home: {
    repository: "router-for-me/CLIProxyAPIHome",
    tag: "v1.1.6",
    commit: "eca75d683c89c1e66a07865d9de530c6cae3ef9f",
    binary: "cli-proxy-api",
    assets: {
      amd64: { name: "CLIProxyAPIHome_1.1.6_linux_amd64_no-plugin.tar.gz", sha256: "e437899f97c0c64dbda1d7e3483dbbd2375d2cb3c849b52309006c14da1074f4" },
      arm64: { name: "CLIProxyAPIHome_1.1.6_linux_aarch64_no-plugin.tar.gz", sha256: "a8ca8efbe41b8de27fc933499312fd2f58c78fc3b888e4a73e5d838d851c12b5" },
    },
  },
  node: {
    repository: "router-for-me/CLIProxyAPI",
    tag: "v8.0.40",
    commit: "d946c4fba6fc9a5cfbca1f3d85184d62ad2fb683",
    binary: "cli-proxy-api",
    assets: {
      amd64: { name: "CLIProxyAPI_8.0.40_linux_amd64_no-plugin.tar.gz", sha256: "9a9cc6c0304632f1f819a7d9f5765afe3768cb02cab69e2f06f42679ec8d9e5a" },
      arm64: { name: "CLIProxyAPI_8.0.40_linux_aarch64_no-plugin.tar.gz", sha256: "b53c4132d4c278d92c453596039b541a0b3f3d2832a0ec81938296198e18b3b8" },
    },
  },
};

test("a real release's backup name stays within the provider name cap", () => {
  const released = report({
    base: { gitCommit: "fa2a131065990efc34ff9c35cf303438a3e9aaad", pins: releasedPins },
    candidate: { gitCommit: "e38e9e4830a2df8ea55c23efbc96706adfa56803", pins: releasedPins },
  });
  const metadata = createBackupMetadata(released, "main", "PS_5", false);
  const name = createBackupName(released, "main", "PS_5", false);
  assert.match(name, /^basalt-release-v2-[A-Za-z0-9_-]{43}$/);
  assert.equal(name.length, 61);
  assert.ok(name.length <= MAXIMUM_BACKUP_NAME_LENGTH);
  assert.ok(legacyNameFor(metadata).length > 800, "the legacy encoding is the name PlanetScale rejected");
  assert.equal(createBackupName(released, "a-much-longer-production-branch-name", "PS_2560", true).length, 61);
});

function legacyNameFor(metadata: BackupMetadata): string {
  return `basalt-release-v1-${deflateRawSync(Buffer.from(stableStringify(metadata))).toString("base64url")}`;
}

test("backup metadata that does not match its name digest fails closed", () => {
  const value = report();
  const name = createBackupName(value, "main", "PS_5", true);
  for (const other of [
    createBackupMetadata(value, "main", "PS_10", true),
    createBackupMetadata(value, "main", "PS_5", false),
    createBackupMetadata(value, "restored", "PS_5", true),
    createBackupMetadata(report({ base: { gitCommit: sha("4"), pins } }), "main", "PS_5", true),
  ])
    assert.throws(() => verifyBackupMetadata(name, other), /does not match the digest in its name/);
  assert.throws(() => verifyBackupMetadata(name, { schemaVersion: 2 }), SafetyGateError);
});

test("legacy v1 names stay readable, but new names are always v2", () => {
  const value = report();
  const metadata = createBackupMetadata(value, "main", "PS_5", true);
  const legacy = legacyNameFor(metadata);
  assert.deepEqual(readBackupName(legacy), { format: "v1", metadata });
  assert.deepEqual(verifyBackupMetadata(legacy), metadata);
  assert.deepEqual(verifyBackupMetadata(legacy, metadata), metadata);
  assert.throws(() => verifyBackupMetadata(legacy, createBackupMetadata(value, "main", "PS_10", true)), /legacy name/);
  const current = createBackupName(value, "main", "PS_5", true);
  assert.deepEqual(readBackupName(current), { format: "v2" });
  assert.throws(() => verifyBackupMetadata(current), /missing its rollback metadata/);
});

test("classifier flag mismatch fails closed", () => {
  const candidate = report({ databaseChanged: false });
  assert.throws(() => parseClassificationReport(candidate), SafetyGateError);
});

test("malformed backup names fail closed", () => {
  const name = createBackupName(report(), "main", "PS_5", true);
  assert.throws(() => readBackupName("basalt-release-v1-not-valid"), SafetyGateError);
  assert.throws(() => readBackupName("basalt-release-v2-short"), /digest is malformed/);
  assert.throws(() => readBackupName(`${name}A`), /digest is malformed/);
  assert.throws(() => readBackupName("basalt-release-v2-" + "!".repeat(43)), /digest is malformed/);
  assert.throws(() => readBackupName("basalt-release-v3-anything"), /unknown Basalt format/);
  assert.throws(() => readBackupName("basalt-release-probe"), /unknown Basalt format/);
  assert.deepEqual(readBackupName(name), { format: "v2" });
  for (const foreign of ["2026.10.27 03:00:00", "", undefined]) {
    assert.equal(readBackupName(foreign), undefined);
    assert.throws(() => verifyBackupMetadata(foreign, createBackupMetadata(report(), "main", "PS_5", true)), /missing Basalt rollback metadata/);
  }
});
