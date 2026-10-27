import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import { parseBackupName } from "./contracts.ts";
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
  const metadata = parseBackupName(backupName);
  assert.equal(metadata.base.gitCommit, report.base.gitCommit);
  assert.equal(metadata.candidate.gitCommit, report.candidate.gitCommit);
  assert.deepEqual(metadata.scope.logicalDatabases, ["postgres", "basalt_pool"]);
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
