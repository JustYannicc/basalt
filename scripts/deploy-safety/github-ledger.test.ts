import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import {
  assertManualRollbackCandidate,
  assertReportUsesLatestDeploy,
  beginRollbackDeployment,
  deploymentPayloadFor,
  readDeploymentLedger,
  type DeploymentLedger,
} from "./github-ledger.ts";
import { createBackupName, summarizePins } from "./contracts.ts";
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

function databaseReport(): ClassificationReport {
  return {
    ...report(),
    databaseChanged: true,
    evidence: { database: { state: "changed", sources: [] }, workflow: { state: "unchanged", sources: [] } },
  };
}

function readyLedger(value: ClassificationReport): Extract<DeploymentLedger, { state: "ready" }> {
  const backupName = value.databaseChanged ? createBackupName(value, "main", "PS_5", true) : undefined;
  return {
    state: "ready",
    deploymentId: 8,
    gitCommit: value.candidate.gitCommit,
    pins: summarizePins(value.candidate.pins),
    payload: deploymentPayloadFor(value, "release", backupName),
  };
}

test("manual rollback baseline comes from the recorded release payload when the release succeeded", () => {
  const value = databaseReport();
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

test("database rollback creates a prior-pin ledger entry for failed and successful releases", async () => {
  const value = databaseReport();
  const backupName = createBackupName(value, "main", "PS_5", true);
  const latestPayload = deploymentPayloadFor(value, "release", backupName);
  const priorReport: ClassificationReport = {
    ...value,
    base: { gitCommit: sha("0"), pins },
    candidate: { gitCommit: value.base.gitCommit, pins: value.base.pins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: { database: { state: "unchanged", sources: [] }, workflow: { state: "unchanged", sources: [] } },
  };
  const priorPayload = deploymentPayloadFor(priorReport);
  for (const currentStatus of ["failure", "success"] as const) {
    const requests: Array<{ method: string; url: URL; body?: Record<string, unknown> }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ method, url, body });
      if (url.pathname.endsWith("/deployments") && method === "GET")
        return Response.json([
          { id: 8, sha: value.candidate.gitCommit, environment: "production", payload: latestPayload, created_at: "2026-10-24T12:00:00Z" },
          { id: 7, sha: value.base.gitCommit, environment: "production", payload: priorPayload, created_at: "2026-10-24T11:00:00Z" },
        ]);
      if (url.pathname.endsWith("/deployments/8/statuses"))
        return Response.json([{ id: 82, state: currentStatus, created_at: "2026-10-24T12:05:00Z" }]);
      if (url.pathname.endsWith("/deployments/7/statuses"))
        return Response.json([{ id: 72, state: "success", created_at: "2026-10-24T11:05:00Z" }]);
      if (url.pathname.endsWith("/deployments") && method === "POST")
        return Response.json({ id: 9, sha: body!.ref, environment: "production", payload: body!.payload }, { status: 201 });
      if (url.pathname.endsWith("/deployments/9/statuses") && method === "POST")
        return Response.json({ id: 92, state: (body as { state: string }).state }, { status: 201 });
      throw new Error(`Unexpected GitHub fixture request: ${method} ${url.pathname}`);
    };

    const id = await beginRollbackDeployment(value, { token: "fixture-token", repository: "owner/repo" }, fetcher, 8);
    assert.equal(id, 9);
    const create = requests.find((request) => request.method === "POST" && request.url.pathname.endsWith("/deployments"))!;
    assert.equal(create.body?.ref, value.base.gitCommit);
    assert.equal(create.body?.description, "Basalt production rollback");
    assert.deepEqual(create.body?.payload, {
      ...deploymentPayloadFor(value, "rollback", backupName),
      rollbackOf: value.candidate.gitCommit,
    });
    assert.deepEqual(requests.filter((request) => request.method === "POST").map((request) => request.body?.state), [undefined, "in_progress"]);
  }
});

test("manual DB rollback rejects unresolved and newer production records", async () => {
  const value = databaseReport();
  const backupName = createBackupName(value, "main", "PS_5", true);
  const latestPayload = deploymentPayloadFor(value, "release", backupName);
  const priorReport: ClassificationReport = {
    ...value,
    base: { gitCommit: sha("0"), pins },
    candidate: { gitCommit: value.base.gitCommit, pins: value.base.pins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: { database: { state: "unchanged", sources: [] }, workflow: { state: "unchanged", sources: [] } },
  };

  for (const status of ["pending", "queued", "in_progress", "missing", "unknown"]) {
    const requests: string[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/deployments"))
        return Response.json([
          { id: 8, sha: value.candidate.gitCommit, environment: "production", payload: latestPayload, created_at: "2026-10-24T12:00:00Z" },
          { id: 7, sha: value.base.gitCommit, environment: "production", payload: deploymentPayloadFor(priorReport), created_at: "2026-10-24T11:00:00Z" },
        ]);
      if (url.pathname.endsWith("/deployments/8/statuses"))
        return Response.json(status === "missing" ? [] : [{ id: 82, state: status, created_at: "2026-10-24T12:05:00Z" }]);
      if (url.pathname.endsWith("/deployments/7/statuses"))
        return Response.json([{ id: 72, state: "success", created_at: "2026-10-24T11:05:00Z" }]);
      throw new Error(`Unexpected GitHub fixture request: ${init?.method ?? "GET"} ${url.pathname}`);
    };
    await assert.rejects(
      beginRollbackDeployment(value, { token: "fixture-token", repository: "owner/repo" }, fetcher, 8),
      /Manual rollback requires the latest release attempt to be complete or failed/,
      status,
    );
    assert.equal(requests.some((request) => request.startsWith("POST ")), false, status);
  }

  const newer = { ...value, candidate: { ...value.candidate, gitCommit: sha("4") } };
  const newerPayload = deploymentPayloadFor(newer, "release", backupName);
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/deployments"))
      return Response.json([
        { id: 9, sha: newer.candidate.gitCommit, environment: "production", payload: newerPayload, created_at: "2026-10-24T13:00:00Z" },
        { id: 8, sha: value.candidate.gitCommit, environment: "production", payload: latestPayload, created_at: "2026-10-24T12:00:00Z" },
      ]);
    if (url.pathname.endsWith("/deployments/9/statuses"))
      return Response.json([{ id: 92, state: "in_progress", created_at: "2026-10-24T13:05:00Z" }]);
    if (url.pathname.endsWith("/deployments/8/statuses"))
      return Response.json([{ id: 82, state: "success", created_at: "2026-10-24T12:05:00Z" }]);
    throw new Error(`Unexpected GitHub fixture request: ${init?.method ?? "GET"} ${url.pathname}`);
  };
  await assert.rejects(
    beginRollbackDeployment(value, { token: "fixture-token", repository: "owner/repo" }, fetcher, 8),
    /changed after the rollback plan was prepared/,
  );
  assert.equal(requests.some((request) => request.startsWith("POST ")), false);
});

test("database rollback ledger start rejects a changed deployment id before creating a record", async () => {
  const value = report();
  const backupName = createBackupName(value, "main", "PS_5", true);
  const latestPayload = deploymentPayloadFor(value, "release", backupName);
  const priorReport: ClassificationReport = {
    ...value,
    base: { gitCommit: sha("0"), pins },
    candidate: { gitCommit: value.base.gitCommit, pins: value.base.pins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: { database: { state: "unchanged", sources: [] }, workflow: { state: "unchanged", sources: [] } },
  };
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/deployments"))
      return Response.json([
        { id: 8, sha: value.candidate.gitCommit, environment: "production", payload: latestPayload, created_at: "2026-10-24T12:00:00Z" },
        { id: 7, sha: value.base.gitCommit, environment: "production", payload: deploymentPayloadFor(priorReport), created_at: "2026-10-24T11:00:00Z" },
      ]);
    if (url.pathname.endsWith("/deployments/8/statuses"))
      return Response.json([{ id: 82, state: "failure", created_at: "2026-10-24T12:05:00Z" }]);
    if (url.pathname.endsWith("/deployments/7/statuses"))
      return Response.json([{ id: 72, state: "success", created_at: "2026-10-24T11:05:00Z" }]);
    throw new Error(`Unexpected GitHub fixture request: ${init?.method ?? "GET"} ${url.pathname}`);
  };
  await assert.rejects(
    beginRollbackDeployment(value, { token: "fixture-token", repository: "owner/repo" }, fetcher, 7),
    /changed after the rollback plan was prepared/,
  );
  assert.equal(requests.some((request) => request === "POST https://api.github.com/repos/owner/repo/deployments"), false);
});

test("initial attempts that all ended without success leave the ledger uninitialized", async () => {
  const value = report();
  const initial = { ...value, base: value.candidate };
  type Record = { id: number; history: string[]; environment?: string };
  const ledgerFor = (records: Record[]) => {
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/deployments"))
        return Response.json(records.map(({ id, environment }, index) => ({
          id,
          sha: initial.candidate.gitCommit,
          environment: environment ?? "production",
          payload: deploymentPayloadFor(initial),
          created_at: `2026-10-25T1${9 - index}:00:00Z`,
        })));
      const match = /\/deployments\/(\d+)\/statuses$/.exec(url.pathname);
      const record = records.find(({ id }) => String(id) === match?.[1]);
      // GitHub lists statuses newest first; each record's history is written oldest first.
      if (record)
        return Response.json(record.history.map((state, index) => ({
          id: record.id * 10 + index,
          state,
          created_at: `2026-10-25T20:0${index}:00Z`,
        })).reverse());
      throw new Error(`Unexpected GitHub fixture request: ${url.pathname}`);
    };
    return readDeploymentLedger({ token: "fixture-token", repository: "owner/repo" }, fetcher);
  };
  const failed = ["in_progress", "failure"];

  // Each attempt's start and final status bound which existing production database a retry may continue with.
  assert.deepEqual(await ledgerFor([{ id: 3, history: failed }]), {
    state: "uninitialized",
    attempts: [{ startedAt: "2026-10-25T19:00:00Z", endedAt: "2026-10-25T20:01:00Z" }],
  });
  assert.deepEqual(
    await ledgerFor([{ id: 3, history: ["in_progress", "error"] }, { id: 2, history: failed }]),
    {
      state: "uninitialized",
      attempts: [
        { startedAt: "2026-10-25T19:00:00Z", endedAt: "2026-10-25T20:01:00Z" },
        { startedAt: "2026-10-25T18:00:00Z", endedAt: "2026-10-25T20:01:00Z" },
      ],
    },
  );

  for (const records of [
    [{ id: 3, history: ["in_progress"] }],
    [{ id: 3, history: [] }],
    [{ id: 3, history: ["in_progress", "inactive"] }],
    [{ id: 3, history: failed }, { id: 2, history: ["pending"] }],
    [{ id: 3, history: failed }, { id: 2, history: [] }],
    [{ id: 3, history: failed }, { id: 2, history: ["in_progress", "success", "inactive"] }],
    [{ id: 3, history: ["in_progress", "success", "failure"] }],
    [{ id: 3, history: failed }, { id: 2, history: failed, environment: "staging" }],
  ]) assert.equal((await ledgerFor(records)).state, "unresolved", JSON.stringify(records));

  const afterSuccess = await ledgerFor([{ id: 4, history: failed }, { id: 3, history: failed }, { id: 2, history: ["in_progress", "success"] }]);
  assert.equal(afterSuccess.state, "unresolved");
  assert.equal(afterSuccess.state === "unresolved" ? afterSuccess.lastSuccessful?.deploymentId : undefined, 2);
});
