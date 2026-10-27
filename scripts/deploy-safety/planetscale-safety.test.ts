import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import {
  createBackupName,
  createBackupMetadata,
  createRecordedBackup,
  MAXIMUM_BACKUP_NAME_LENGTH,
  stableStringify,
  type RecordedBackup,
} from "./contracts.ts";
import { PlanetScaleSafety } from "./planetscale-safety.ts";

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

const report: ClassificationReport = {
  schemaVersion: 1,
  base: { gitCommit: sha("1"), pins },
  candidate: { gitCommit: sha("2"), pins: { ...pins, tools: { ...pins.tools, commit: sha("3") } } },
  databaseChanged: true,
  workflowChanged: false,
  evidence: {
    database: { state: "unknown", sources: [] },
    workflow: { state: "unchanged", sources: [] },
  },
};

function paginated(data: unknown[], totalCount = data.length) {
  return {
    type: "list",
    current_page: 1,
    per_page: 100,
    next_page: null,
    total_count: totalCount,
    total_pages: totalCount === 0 ? 0 : 1,
    data,
  };
}

function backupRecord(name: string, state: string, protectedState: boolean) {
  return {
    id: "backup-id",
    name,
    state,
    protected: protectedState,
    deleted_at: null,
    database_branch: { name: "main" },
    restored_branches: [],
  };
}

test("branch backup is completed, protected and records both logical databases with the service-token header", async () => {
  const requests: Array<{ method: string; url: URL; headers: Headers; body?: unknown }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    let body: unknown;
    if (init?.body) body = JSON.parse(String(init.body));
    requests.push({ method, url, headers: new Headers(init?.headers), body });

    if (url.pathname.endsWith("/databases") && method === "GET")
      return Response.json(paginated([{ name: "basalt", kind: "postgresql", ready: true, default_branch: "main" }]));
    if (url.pathname.endsWith("/databases/basalt") && method === "GET")
      return Response.json({ name: "basalt", kind: "postgresql", ready: true, default_branch: "main" });
    if (url.pathname.endsWith("/branches/main") && method === "GET")
      return Response.json({ id: "branch-id", name: "main", kind: "postgresql", state: "ready", ready: true, production: true, cluster_name: "PS_5", has_replicas: true });
    if (url.pathname.endsWith("/branches/main/backups") && method === "GET")
      return Response.json(paginated([]));
    if (url.pathname.endsWith("/branches/main/backups") && method === "POST")
      return Response.json(backupRecord(String((body as { name: string }).name), "pending", false), { status: 201 });
    if (url.pathname.endsWith("/branches/main/backups/backup-id") && method === "GET")
      return Response.json(backupRecord(String((body as { name?: string } | undefined)?.name ?? backupNameFromRequests(requests)), "success", method === "GET" && requests.some((request) => request.method === "PATCH")));
    if (url.pathname.endsWith("/branches/main/backups/backup-id") && method === "PATCH")
      return Response.json(backupRecord(backupNameFromRequests(requests), "success", true));
    throw new Error(`Unexpected PlanetScale fixture request: ${method} ${url.pathname}`);
  };

  const safety = new PlanetScaleSafety(
    { organization: "basalt-org", tokenId: "service-id-fixture", token: "service-secret-fixture" },
    fetcher,
    { now: () => 1, timeoutMs: 10, pollIntervalMs: 0, sleep: async () => {} },
  );
  const result = await safety.ensureBackup(report, false);
  assert.equal(result.state, "ready");
  if (result.state !== "ready") throw new Error("Expected a ready backup");
  assert.equal(result.backupId, "backup-id");

  const create = requests.find((request) => request.method === "POST")!;
  const backupName = (create.body as { name: string }).name;
  assert.equal(backupName, result.backupName);
  assert.ok(backupName.length <= MAXIMUM_BACKUP_NAME_LENGTH);
  assert.equal(backupName, createBackupName(report, "main", "PS_5", true));
  assert.deepEqual(createBackupMetadata(report, "main", "PS_5", true).scope.logicalDatabases, ["postgres", "basalt_pool"]);
  assert.deepEqual(create.body, { name: backupName, emergency: false });
  assert.equal(requests.some((request) => request.method === "PATCH" && (request.body as { protected?: boolean }).protected === true), true);
  assert.ok(requests.every((request) => request.headers.get("authorization") === "service-id-fixture:service-secret-fixture"));
  assert.ok(requests.every((request) => !request.headers.get("authorization")?.startsWith("Bearer ")));
});

function backupNameFromRequests(requests: Array<{ method: string; body?: unknown }>): string {
  const request = requests.find((item) => item.method === "POST");
  if (!request || !request.body) throw new Error("Backup was not created");
  return (request.body as { name: string }).name;
}

test("an initial retry continues only with a database created inside a failed attempt", async () => {
  const safetyWith = (databases: unknown[]) => new PlanetScaleSafety(
    { organization: "basalt-org", tokenId: "service-id-fixture", token: "service-secret-fixture" },
    async () => Response.json(paginated(databases)),
    { now: () => 1, timeoutMs: 10, pollIntervalMs: 0, sleep: async () => {} },
  );
  const basalt = (createdAt?: string) => ({
    name: "basalt", kind: "postgresql", ready: true, default_branch: "main",
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
  });
  // The live case: attempt record 15:27:42Z, database 15:28:17Z, failure status 15:32:16Z.
  const attempts = [
    { startedAt: "2026-10-27T15:27:42Z", endedAt: "2026-10-27T15:32:16Z" },
    { startedAt: "2026-10-25T19:10:31Z", endedAt: "2026-10-25T19:11:18Z" },
  ];
  await safetyWith([]).assertInitialDatabaseAbsent();
  await safetyWith([]).assertInitialDatabaseAbsent(attempts);
  await safetyWith([basalt("2026-10-27T15:28:17.006Z")]).assertInitialDatabaseAbsent(attempts);
  await safetyWith([basalt("2026-10-25T19:11:00Z")]).assertInitialDatabaseAbsent(attempts);
  for (const [databases, windows] of [
    [[basalt("2026-10-27T15:28:17.006Z")], []],
    [[basalt("2026-10-27T15:27:41Z")], attempts],
    [[basalt("2026-10-26T12:00:00Z")], attempts],
    [[basalt("2026-10-27T15:40:00Z")], attempts],
    [[basalt()], attempts],
    [[basalt("not a time")], attempts],
    [[basalt("2026-10-27T15:28:17.006Z")], [{ startedAt: "not a time", endedAt: "2026-10-27T15:32:16Z" }]],
  ] as const)
    await assert.rejects(
      safetyWith([...databases]).assertInitialDatabaseAbsent([...windows]),
      /PlanetScale database already exists/,
      JSON.stringify({ databases, windows }),
    );
});

type FixtureBranch = { cluster: string; replicas: boolean; backups: Array<{ id: string; name: string }> };

function rollbackSafety(branches: Record<string, FixtureBranch>) {
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (method !== "GET") throw new Error(`Unexpected PlanetScale write: ${method} ${url.pathname}`);
    const path = url.pathname.replace(/^.*\/databases/, "");
    if (path === "")
      return Response.json(paginated([{ name: "basalt", kind: "postgresql", ready: true, default_branch: "main" }]));
    if (path === "/basalt/branches")
      return Response.json(paginated(Object.entries(branches).map(([name, branch]) => ({
        id: `${name}-id`, name, kind: "postgresql", state: "ready", ready: true, production: name === "main",
        cluster_name: branch.cluster, has_replicas: branch.replicas,
      }))));
    const match = /^\/basalt\/branches\/([^/]+)\/backups(?:\/([^/]+))?$/.exec(path);
    const branch = match && branches[match[1]!];
    if (match && branch) {
      const records = branch.backups.map((backup) => ({ ...backupRecord(backup.name, "success", true), id: backup.id, database_branch: { name: match[1] } }));
      if (!match[2]) return Response.json(paginated(records));
      const found = records.find((backup) => backup.id === match[2]);
      if (found) return Response.json(found);
    }
    throw new Error(`Unexpected PlanetScale fixture request: ${method} ${url.pathname}`);
  };
  const safety = new PlanetScaleSafety(
    { organization: "basalt-org", tokenId: "service-id-fixture", token: "service-secret-fixture" },
    fetcher,
  );
  return { safety, requests };
}

function recordedFor(value: ClassificationReport, branch = "main", cluster = "PS_5", replicas = true): RecordedBackup {
  return createRecordedBackup(value, branch, cluster, replicas);
}

test("the rollback target is the exact recorded v2 backup, matched by digest and verified against the report", async () => {
  const recorded = recordedFor(report);
  const otherRelease = recordedFor({ ...report, candidate: { ...report.candidate, gitCommit: "4".repeat(40) } });
  const branches = {
    main: {
      cluster: "PS_5",
      replicas: true,
      backups: [
        { id: "system", name: "2026.10.27 03:00:00" },
        { id: "other", name: otherRelease.name },
        { id: "backup-id", name: recorded.name },
      ],
    },
    restored: { cluster: "PS_5", replicas: true, backups: [] },
  };

  const target = await rollbackSafety(branches).safety.manualRollbackTarget(report, recorded);
  assert.deepEqual(target, {
    backupId: "backup-id",
    backupName: recorded.name,
    productionBranch: "main",
    base: recorded.metadata.base,
    candidate: recorded.metadata.candidate,
    logicalDatabases: ["postgres", "basalt_pool"],
    manualRestoreRequired: true,
  });

  // Without a ledger record, the production branch's expected name is recomputed from its current context.
  const ready = await rollbackSafety(branches).safety.assertBackupReady(report);
  assert.equal(ready.backup.id, "backup-id");
  assert.deepEqual(ready.metadata, recorded.metadata);

  // After a resize the recomputed name no longer matches, but the recorded metadata still finds it.
  const resized = { ...branches, main: { ...branches.main, cluster: "PS_10" } };
  await assert.rejects(rollbackSafety(resized).safety.assertBackupReady(report), /Expected exactly one/);
  assert.equal((await rollbackSafety(resized).safety.manualRollbackTarget(report, recorded)).backupId, "backup-id");
});

test("rollback target selection fails closed on digest mismatch, ambiguity and malformed Basalt names", async () => {
  const recorded = recordedFor(report);
  const branchWith = (...backups: Array<{ id: string; name: string }>) => ({ main: { cluster: "PS_5", replicas: true, backups } });

  const tampered = rollbackSafety(branchWith({ id: "backup-id", name: recorded.name }));
  await assert.rejects(
    tampered.safety.manualRollbackTarget(report, { name: recorded.name, metadata: recordedFor(report, "main", "PS_10").metadata }),
    /does not match the digest in its name/,
  );
  assert.deepEqual(tampered.requests, []);

  const otherRelease = recordedFor({ ...report, base: { ...report.base, gitCommit: "5".repeat(40) } });
  await assert.rejects(
    rollbackSafety(branchWith({ id: "backup-id", name: otherRelease.name })).safety.manualRollbackTarget(report, otherRelease),
    /does not match the classified release transition/,
  );

  await assert.rejects(
    rollbackSafety(branchWith({ id: "a", name: recorded.name }, { id: "b", name: recorded.name })).safety.manualRollbackTarget(report, recorded),
    /Expected exactly one/,
  );
  await assert.rejects(
    rollbackSafety(branchWith({ id: "backup-id", name: recorded.name }, { id: "bad", name: "basalt-release-v2-short" })).safety.manualRollbackTarget(report, recorded),
    /digest is malformed/,
  );
  await assert.rejects(rollbackSafety(branchWith()).safety.manualRollbackTarget(report, recorded), /Expected exactly one/);
});

test("without a ledger record, only a production-branch backup counts", async () => {
  const onDevelopment = recordedFor(report, "development");
  const branches = {
    main: { cluster: "PS_5", replicas: true, backups: [] },
    development: { cluster: "PS_5", replicas: true, backups: [{ id: "development-backup", name: onDevelopment.name }] },
  };
  await assert.rejects(rollbackSafety(branches).safety.assertBackupReady(report), /Expected exactly one/);
  // A recorded backup names its branch, so a restore that moved production does not strand it.
  assert.equal((await rollbackSafety(branches).safety.assertBackupReady(report, onDevelopment)).backup.id, "development-backup");
});

test("a v1 backup name only counts when the ledger records it", async () => {
  const { metadata } = recordedFor(report);
  const v1 = `basalt-release-v1-${deflateRawSync(Buffer.from(stableStringify(metadata))).toString("base64url")}`;
  const branches = { main: { cluster: "PS_5", replicas: true, backups: [{ id: "v1-backup", name: v1 }] } };
  await assert.rejects(rollbackSafety(branches).safety.assertBackupReady(report), /Expected exactly one/);
  assert.equal((await rollbackSafety(branches).safety.assertBackupReady(report, { name: v1, metadata })).backup.id, "v1-backup");
});
