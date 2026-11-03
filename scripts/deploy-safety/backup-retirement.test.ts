import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import { backupRetirementReport, backupSnapshotDigest, type BackupInventory } from "./backup-retirement-policy.ts";
import { readBackupRetirementReport } from "./backup-retirement.ts";
import { createRecordedBackup } from "./contracts.ts";
import { deploymentPayloadFor, type BackupDeployment } from "./github-ledger.ts";
import type { BackupRecord, BranchRecord } from "./planetscale-api.ts";

const now = Date.parse("2026-11-03T12:00:00Z");
const day = 86_400_000;
const sha = (value: number) => value.toString(16).padStart(40, "0");
const artifact = { tag: "v1", commit: sha(1), binary: "fixture", assets: { amd64: { name: "amd64", sha256: "a".repeat(64) }, arm64: { name: "arm64", sha256: "b".repeat(64) } } };
const pins: ReleasePins = {
  tools: { repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: sha(1) },
  home: { ...artifact, repository: "https://github.com/router-for-me/CLIProxyAPIHome.git" },
  node: { ...artifact, repository: "https://github.com/router-for-me/CLIProxyAPI.git" },
};

function fixture(branchNames = ["main"]) {
  const history: BackupDeployment[] = [];
  const inventory: BackupInventory = { organization: "fixture-org", database: "basalt", branches: [] };
  let sequence = 0;
  for (const name of branchNames) {
    const branch: BranchRecord = { id: `branch-${name}`, name, kind: "postgresql", state: "ready", ready: true, production: true, cluster_name: "PS_5", has_replicas: true };
    const backups: BackupRecord[] = [];
    for (let index = 1; index <= 15; index++) {
      const id = ++sequence;
      const classification: ClassificationReport = {
        schemaVersion: 1,
        base: { gitCommit: sha(1), pins }, candidate: { gitCommit: sha(id + 1), pins },
        databaseChanged: true, workflowChanged: false,
        evidence: { database: { state: "unknown", sources: [] }, workflow: { state: "unchanged", sources: [] } },
      };
      const recorded = createRecordedBackup(classification, name, "PS_5", true);
      const createdAt = new Date(now - (40 + index) * day).toISOString();
      backups.push({
        id: `backup-${name}-${index}`, name: recorded.name, state: "success", protected: true,
        created_at: createdAt, size: index * 100, deleted_at: null, required: false, backup_policy: null,
        database_branch: { name }, restored_branches: [],
      });
      history.push({ id, gitCommit: classification.candidate.gitCommit, createdAt, status: "success", successful: true, payload: deploymentPayloadFor(classification, "release", recorded) });
    }
    inventory.branches.push({ branch, backups });
  }
  history.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id);
  return { inventory, history };
}

function reviewFor(inventory: BackupInventory, history: BackupDeployment[]) {
  return {
    schemaVersion: 1,
    scope: { organization: inventory.organization, database: inventory.database },
    inventoryDigest: backupSnapshotDigest(inventory), ledgerDigest: backupSnapshotDigest(history),
    reviewedAt: new Date(now).toISOString(),
    branches: inventory.branches.map(({ branch }) => ({
      branch: branch.name, latestMigrationRecoveryBackupId: `backup-${branch.name}-13`,
      pinnedBackupIds: [`backup-${branch.name}-12`], restoreDependentBackupIds: [`backup-${branch.name}-14`],
      evidenceDigests: { latestMigration: "a".repeat(64), pins: "b".repeat(64), restoreDependencies: "c".repeat(64) },
    })),
  };
}

test("retirement requires both age and count and preserves reviewed and provider restore dependencies per production branch", () => {
  const { inventory, history } = fixture(["main", "restored-production"]);
  for (const entry of inventory.branches) entry.backups[14]!.restored_branches = [{ id: "restored-branch" }];
  const result = backupRetirementReport(inventory, history, now, reviewFor(inventory, history));
  assert.equal(result.readOnly, true);
  assert.equal(result.deletionAuthorized, false);
  assert.deepEqual(result.candidates.map(item => item.id).sort(), ["backup-main-11", "backup-restored-production-11"]);
  assert.equal(result.backups.filter(item => item.completedReleaseRank! <= 10 && item.decision === "keep").length, 20);
  const row = (id: string) => result.backups.find(item => item.id === id)!;
  assert.ok(row("backup-main-12").reasons.includes("explicit-pin"));
  assert.ok(row("backup-main-13").reasons.includes("latest-production-migration-recovery"));
  assert.ok(row("backup-main-14").reasons.includes("reviewed-restore-dependency"));
  assert.ok(row("backup-main-15").reasons.includes("restore-dependent-backup"));
  inventory.branches[0]!.backups[10]!.created_at = new Date(now - 30 * day).toISOString();
  const atBoundary = backupRetirementReport(inventory, history, now, reviewFor(inventory, history));
  assert.ok(atBoundary.backups.find(item => item.id === "backup-main-11")!.reasons.includes("not-older-than-30-days"));
});

test("unverified release names cannot displace the tenth verified release backup", () => {
  const { inventory, history } = fixture();
  inventory.branches[0]!.backups.push({
    ...inventory.branches[0]!.backups[0]!, id: "unknown-newer", name: "basalt-release-v2-" + "x".repeat(43),
    created_at: new Date(now - 40 * day).toISOString(),
  });
  const result = backupRetirementReport(inventory, history, now, reviewFor(inventory, history));
  const tenth = result.backups.find(item => item.id === "backup-main-10")!;
  assert.equal(tenth.completedReleaseRank, 10);
  assert.equal(tenth.decision, "keep");
  assert.equal(result.backups.find(item => item.id === "unknown-newer")!.decision, "keep");
});

test("external keep evidence is required and the exact review is hashed into the output", () => {
  const { inventory, history } = fixture();
  const review = reviewFor(inventory, history);
  const result = backupRetirementReport(inventory, history, now, review);
  assert.equal(result.keepReviewDigest, backupSnapshotDigest(review));
  const changed = { ...review, branches: [{ ...review.branches[0]!, evidenceDigests: { ...review.branches[0]!.evidenceDigests, pins: "d".repeat(64) } }] };
  assert.notEqual(backupRetirementReport(inventory, history, now, changed).keepReviewDigest, result.keepReviewDigest);
  for (const evidenceDigests of [undefined, {}, { latestMigration: "a".repeat(64), pins: "", restoreDependencies: "c".repeat(64) }]) {
    const held = backupRetirementReport(inventory, history, now, { ...review, branches: [{ ...review.branches[0], evidenceDigests }] });
    assert.deepEqual(held.candidates, []);
    assert.equal(held.keepReviewDigest, null);
  }
});

test("the current rollback target after roll-forward is selected through releaseBackup, even outside the newest ten", () => {
  const { inventory, history } = fixture();
  inventory.branches[0]!.backups[14]!.restored_branches = [{ id: "restore" }];
  const latest = history[0]!;
  const failed = history[10]!;
  failed.status = "failure";
  failed.successful = false;
  latest.payload = {
    ...latest.payload!, rollForwardOf: failed.gitCommit,
    rollbackBackup: { name: failed.payload!.backupName!, metadata: failed.payload!.backupMetadata! },
  };
  const result = backupRetirementReport(inventory, history, now, reviewFor(inventory, history));
  const row = result.backups.find(item => item.id === "backup-main-11")!;
  assert.equal(row.decision, "keep");
  assert.ok(row.reasons.includes("current-exact-rollback-backup"));
  assert.ok(row.reasons.includes("unresolved-release"));
  assert.ok(!result.holds.includes("release-backup-metadata-conflicts"));
});

test("a later code-only release still keeps the last successful database release's recovery point", () => {
  const { inventory, history } = fixture();
  for (const entry of history) entry.payload = { ...entry.payload!, databaseChanged: false };
  history[10]!.payload = { ...history[10]!.payload!, databaseChanged: true };
  history[0]!.payload = { ...history[0]!.payload!, backupName: undefined, backupMetadata: undefined };
  const result = backupRetirementReport(inventory, history, now, reviewFor(inventory, history));
  assert.ok(result.backups.find(item => item.id === "backup-main-11")!.reasons.includes("latest-release-migration-recovery"));
});

test("missing, stale, foreign or incomplete keep evidence never produces retirement candidates", () => {
  const { inventory, history } = fixture();
  const review = reviewFor(inventory, history);
  for (const evidence of [
    undefined,
    { ...review, inventoryDigest: "0".repeat(64) },
    { ...review, ledgerDigest: "0".repeat(64) },
    { ...review, scope: { ...review.scope, organization: "another-org" } },
    { ...review, branches: [] },
    { ...review, branches: [{ ...review.branches[0], latestMigrationRecoveryBackupId: "unknown" }] },
    { ...review, branches: [{ ...review.branches[0], pinnedBackupIds: undefined }] },
    { ...review, reviewedAt: new Date(now + 1).toISOString() },
  ]) {
    const result = backupRetirementReport(inventory, history, now, evidence);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.holds.length);
  }
});

test("unknown ledger entries, missing recovery points and uncertain ordering keep all backups", () => {
  for (const change of [
    (inventory: BackupInventory, history: BackupDeployment[]) => { history[4]!.payload = undefined; },
    (inventory: BackupInventory) => { inventory.branches[0]!.backups.shift(); },
    (inventory: BackupInventory) => { inventory.branches[0]!.backups[2]!.created_at = "invalid"; },
    (inventory: BackupInventory) => { inventory.branches[0]!.branch.ready = false; },
  ]) {
    const { inventory, history } = fixture();
    change(inventory, history);
    assert.deepEqual(backupRetirementReport(inventory, history, now, reviewFor(inventory, history)).candidates, []);
  }
});

test("unverified backup detail, scheduled policy and orphaned ownership cannot become candidates", () => {
  for (const change of [
    (backup: BackupRecord) => { delete backup.restored_branches; },
    (backup: BackupRecord) => { delete backup.backup_policy; },
    (backup: BackupRecord) => { backup.backup_policy = { id: "scheduled" }; },
    (backup: BackupRecord) => { backup.required = true; },
    (backup: BackupRecord) => { backup.database_branch = { name: "elsewhere" }; },
    (backup: BackupRecord) => { backup.protected = false; },
    (backup: BackupRecord) => { backup.state = "running"; },
    (backup: BackupRecord) => { backup.name = "basalt-release-v2-" + "x".repeat(43); },
  ]) {
    const { inventory, history } = fixture();
    change(inventory.branches[0]!.backups[10]!);
    const result = backupRetirementReport(inventory, history, now, reviewFor(inventory, history));
    assert.equal(result.backups.find(item => item.id === "backup-main-11")!.decision, "keep");
  }
});

test("the public report reads all backup pages and details and validated deployment history using GET only", async () => {
  const { inventory, history } = fixture();
  inventory.branches[0]!.backups[14]!.restored_branches = [{ id: "restore" }];
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "GET");
    requests.push(url.pathname + url.search);
    if (url.hostname === "api.planetscale.com") {
      const { branch, backups } = inventory.branches[0]!;
      if (url.pathname.endsWith("/databases/basalt")) return Response.json({ name: "basalt", kind: "postgresql", ready: true, default_branch: "main" });
      if (url.pathname.endsWith("/branches")) return Response.json(page([branch]));
      if (url.pathname.endsWith("/backups")) {
        const number = Number(url.searchParams.get("page"));
        return Response.json({ ...page(backups.slice(number === 1 ? 0 : 8, number === 1 ? 8 : 15)), current_page: number, total_pages: 2, total_count: 15, next_page: number === 1 ? 2 : null });
      }
      const backup = backups.find(item => url.pathname.endsWith(`/backups/${item.id}`));
      if (backup) return Response.json(backup);
    }
    if (url.hostname === "api.github.com") {
      if (url.pathname.endsWith("/deployments")) return Response.json(history.map(entry => ({ id: entry.id, sha: entry.gitCommit, created_at: entry.createdAt, environment: "production", payload: entry.payload })));
      const entry = history.find(item => url.pathname.endsWith(`/deployments/${item.id}/statuses`));
      if (entry) return Response.json([{ id: entry.id, state: "success", created_at: entry.createdAt }]);
    }
    throw new Error(`Unexpected fixture URL: ${url.pathname}`);
  };
  const credentials = { organization: "fixture-org", tokenId: "fixture-id", token: "fixture-secret" };
  const github = { repository: "fixture/basalt", token: "github-fixture-secret" };
  const first = await readBackupRetirementReport(credentials, github, undefined, fetcher, () => now);
  assert.deepEqual(first.candidates, []);
  const reviewed = await readBackupRetirementReport(credentials, github, {
    ...reviewFor(inventory, history), inventoryDigest: first.inventoryDigest, ledgerDigest: first.ledgerDigest,
  }, fetcher, () => now);
  assert.deepEqual(reviewed.candidates, [{ branch: "main", id: "backup-main-11", name: inventory.branches[0]!.backups[10]!.name }]);
  assert.ok(requests.some(path => path.includes("backups?page=2")));
  assert.ok(requests.some(path => path.endsWith("/backups/backup-main-15")));
  assert.ok(!JSON.stringify(reviewed).includes("fixture-secret"));
  history[5]!.payload = undefined;
  const unknown = await readBackupRetirementReport(credentials, github, undefined, fetcher, () => now);
  assert.ok(unknown.holds.includes("release-ledger-unverified"));
});

function page(data: unknown[]) {
  return { type: "list", current_page: 1, per_page: 100, next_page: null, total_count: data.length, total_pages: data.length ? 1 : 0, data };
}
