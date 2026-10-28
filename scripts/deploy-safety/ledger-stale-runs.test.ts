// A release job killed hard leaves its deployment record unfinished. When the run attempt the
// record names has completed, the ledger reads the record as failed, in memory only.
import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import {
  beginReleaseDeployment,
  deploymentPayloadFor,
  KILLED_RUN_GRACE_MS,
  readDeploymentLedger,
  readLedgerEnvironment,
  type DeploymentPayload,
  type RollForward,
  type RunIdentity,
} from "./github-ledger.ts";

const sha = (character: string) => character.repeat(40);
const environment = { token: "fixture-token", repository: "owner/repo" };

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

function transition(base: string, candidate: string): ClassificationReport {
  return {
    schemaVersion: 1,
    base: { gitCommit: base, pins },
    candidate: { gitCommit: candidate, pins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: { database: { state: "unchanged", sources: [] }, workflow: { state: "unchanged", sources: [] } },
  };
}

const run: RunIdentity = { repository: "owner/repo", id: 4242, attempt: 2 };
const payloadOf = (base: string, candidate: string, owner: unknown = null): DeploymentPayload =>
  ({ ...deploymentPayloadFor(transition(base, candidate)), ...(owner === null ? {} : { run: owner }) } as DeploymentPayload);

type Row = { id: number; sha: string; payload: unknown; history: string[] };
const success: Row = { id: 7, sha: sha("1"), payload: payloadOf(sha("0"), sha("1")), history: ["in_progress", "success"] };
const killed = (history = ["in_progress"], owner: unknown = run): Row =>
  ({ id: 8, sha: sha("2"), payload: payloadOf(sha("1"), sha("2"), owner), history });

type Actions = { status: number; body?: unknown };
const runReply = (status: string, overrides: Record<string, unknown> = {}): Actions => ({
  status: 200,
  body: { id: 4242, run_attempt: 2, status, conclusion: status === "completed" ? "cancelled" : null, updated_at: "2026-10-28T20:00:00Z", repository: { full_name: "owner/repo" }, ...overrides },
});

function fetcherFor(rows: Row[], actions: Actions, requests: string[] = [], posted: Array<Record<string, unknown>> = []) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (url.pathname === "/repos/owner/repo/actions/runs/4242/attempts/2")
      return actions.body === undefined ? new Response("unavailable", { status: actions.status }) : Response.json(actions.body, { status: actions.status });
    if (url.pathname.endsWith("/deployments") && method === "GET")
      return Response.json(rows.map(({ id, sha: commit, payload }, index) => ({
        id, sha: commit, environment: "production", payload, created_at: `2026-10-28T1${8 - index}:00:00Z`,
      })));
    if (url.pathname.endsWith("/deployments") && method === "POST") {
      posted.push(body!);
      return Response.json({ id: 9, sha: body!.ref, environment: "production", payload: body!.payload }, { status: 201 });
    }
    const match = /\/deployments\/(\d+)\/statuses$/.exec(url.pathname);
    if (match && method === "POST") {
      posted.push(body!);
      return Response.json({ id: 99, state: body!.state }, { status: 201 });
    }
    const row = rows.find(({ id }) => String(id) === match?.[1]);
    if (row) return Response.json(row.history.map((state, index) => ({
      id: row.id * 10 + index, state, created_at: `2026-10-28T19:0${index}:00Z`,
    })).reverse());
    throw new Error(`Unexpected GitHub fixture request: ${method} ${url.pathname}`);
  };
}

const releasing: RollForward = { candidateGitCommit: sha("3"), contains: (ancestor) => ancestor === sha("2") };

// The fixture run attempt completed at 20:00; an hour later is well past the grace period.
const completedAt = Date.parse("2026-10-28T20:00:00Z");
const later = () => completedAt + 60 * 60 * 1000;

test("an unfinished record whose run attempt completed reads as failed, then rolls forward", async () => {
  for (const history of [["in_progress"], ["queued"], ["pending"], []]) {
    const requests: string[] = [];
    const ledger = await readDeploymentLedger(environment, fetcherFor([killed(history), success], runReply("completed"), requests), undefined, later);
    assert.equal(ledger.state, "unresolved", JSON.stringify(history));
    assert.equal(ledger.state === "unresolved" ? ledger.deploymentStatus : "", "failure");
    assert.match(ledger.state === "unresolved" ? ledger.reason : "", /run that owned the latest production deployment finished/);
    assert.equal(requests.filter((request) => !request.startsWith("GET ")).length, 0, "nothing is written back");

    const rolled = await readDeploymentLedger(environment, fetcherFor([killed(history), success], runReply("completed")), releasing, later);
    assert.equal(rolled.state, "ready", JSON.stringify(history));
    assert.equal(rolled.state === "ready" ? rolled.superseded?.gitCommit : "", sha("2"));
  }
  // Any conclusion counts once the attempt has completed.
  const failedRun = runReply("completed", { conclusion: "failure" });
  assert.equal((await readDeploymentLedger(environment, fetcherFor([killed(), success], failedRun), releasing, later)).state, "ready");
});

test("an unfinished record whose run attempt is still running stays blocked", async () => {
  for (const status of ["in_progress", "queued", "waiting", "requested", "pending"]) {
    const ledger = await readDeploymentLedger(environment, fetcherFor([killed(), success], runReply(status)), releasing, later);
    assert.equal(ledger.state, "unresolved", status);
    assert.equal(ledger.state === "unresolved" ? ledger.deploymentStatus : "", "in_progress", status);
  }
});

test("an Actions API error or a reply about another run keeps the record blocked", async () => {
  const replies: Actions[] = [
    { status: 500 },
    { status: 404 },
    { status: 403 },
    runReply("completed", { id: 1 }),
    runReply("completed", { run_attempt: 1 }),
    runReply("completed", { repository: { full_name: "other/repo" } }),
    runReply("completed", { updated_at: "not a time" }),
    { status: 200, body: { id: 4242 } },
  ];
  for (const reply of replies) {
    const ledger = await readDeploymentLedger(environment, fetcherFor([killed(), success], reply), releasing, later);
    assert.equal(ledger.state, "unresolved", JSON.stringify(reply));
    assert.equal(ledger.state === "unresolved" ? ledger.deploymentStatus : "", "in_progress", JSON.stringify(reply));
  }
});

test("a record with no run identity keeps the old behavior and never asks Actions", async () => {
  const requests: string[] = [];
  const ledger = await readDeploymentLedger(environment, fetcherFor([killed(["in_progress"], null), success], runReply("completed"), requests), releasing, later);
  assert.equal(ledger.state, "unresolved");
  assert.equal(ledger.state === "unresolved" ? ledger.deploymentStatus : "", "in_progress");
  assert.equal(requests.some((request) => request.includes("/actions/")), false);
});

test("a run identity naming another repository is rejected, and a malformed one fails the read", async () => {
  const requests: string[] = [];
  const foreign = killed(["in_progress"], { repository: "other/repo", id: 4242, attempt: 2 });
  const ledger = await readDeploymentLedger(environment, fetcherFor([foreign, success], runReply("completed"), requests), releasing, later);
  assert.equal(ledger.state, "unresolved");
  assert.equal(ledger.state === "unresolved" ? ledger.deploymentStatus : "", "in_progress");
  assert.equal(requests.some((request) => request.includes("/actions/")), false);

  for (const owner of [{ repository: "owner/repo", id: "4242", attempt: 2 }, { repository: "owner/repo", id: 4242, attempt: 0 },
    { repository: "owner repo", id: 4242, attempt: 2 }, { repository: "owner/repo", id: 4242, attempt: 2, url: "x" }, "4242"])
    await assert.rejects(readDeploymentLedger(environment, fetcherFor([killed(["in_progress"], owner), success], runReply("completed"))), /run identity/, JSON.stringify(owner));
});

test("without a previous success, a killed first attempt stays unresolved as before", async () => {
  const first: Row = { id: 8, sha: sha("2"), payload: payloadOf(sha("2"), sha("2"), run), history: ["in_progress"] };
  const ledger = await readDeploymentLedger(environment, fetcherFor([first], runReply("completed")));
  assert.equal(ledger.state, "unresolved");
  assert.equal(ledger.state === "unresolved" ? ledger.deploymentStatus : "", "in_progress");
});

test("the runner records its run attempt on each deployment it creates and links it from each status", async () => {
  const runEnvironment = readLedgerEnvironment({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "4242", GITHUB_RUN_ATTEMPT: "2" });
  assert.deepEqual(runEnvironment.run, run);
  assert.equal(readLedgerEnvironment({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "owner/repo" }).run, undefined);
  for (const [id, attempt] of [["4242", undefined], ["x", "1"], ["4242", "0"]])
    assert.throws(() => readLedgerEnvironment({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: attempt }), /identify this Actions run attempt/);

  const posted: Array<Record<string, unknown>> = [];
  await beginReleaseDeployment(transition(sha("1"), sha("3")), runEnvironment, fetcherFor([success], runReply("in_progress"), [], posted));
  assert.deepEqual((posted[0]!.payload as DeploymentPayload).run, run);
  assert.equal(posted[1]!.log_url, "https://github.com/owner/repo/actions/runs/4242/attempts/2");
});

test("an attempt completed within the grace period stays blocked, and one past it reads as failed", async () => {
  assert.equal(KILLED_RUN_GRACE_MS, 15 * 60 * 1000);
  const at = (elapsed: number) => readDeploymentLedger(environment, fetcherFor([killed(), success], runReply("completed")), releasing, () => completedAt + elapsed);
  for (const elapsed of [0, 60_000, KILLED_RUN_GRACE_MS - 1]) {
    const ledger = await at(elapsed);
    assert.equal(ledger.state, "unresolved", String(elapsed));
    assert.equal(ledger.state === "unresolved" ? ledger.deploymentStatus : "", "in_progress");
  }
  assert.equal((await at(KILLED_RUN_GRACE_MS)).state, "ready");
});

test("the refusal says why a killed record still blocks, without response bodies", async () => {
  const cases: Array<[Actions, RegExp]> = [
    [{ status: 403, body: { message: "secret-body-text" } }, /run 4242 attempt 2 lookup failed \(HTTP 403\)/],
    [{ status: 404 }, /run 4242 attempt 2 lookup failed \(HTTP 404\)/],
    [runReply("in_progress"), /run 4242 attempt 2 is still in_progress/],
    [runReply("completed", { run_attempt: 1 }), /lookup answered about another run/],
    [runReply("completed", { updated_at: "soon" }), /completed without a usable completion time/],
  ];
  for (const [reply, why] of cases) {
    const ledger = await readDeploymentLedger(environment, fetcherFor([killed(), success], reply), releasing, later);
    assert.equal(ledger.state, "unresolved", JSON.stringify(reply));
    if (ledger.state !== "unresolved") continue;
    assert.match(ledger.reason, why);
    assert.match(ledger.supersedeRefusal ?? "", why);
    assert.doesNotMatch(`${ledger.reason} ${ledger.supersedeRefusal}`, /secret-body-text|fixture-token/);
  }
  const grace = await readDeploymentLedger(environment, fetcherFor([killed(), success], runReply("completed")), releasing, () => completedAt);
  assert.match(grace.state === "unresolved" ? grace.supersedeRefusal ?? "" : "", /still within the 15-minute grace period/);
  const foreign = killed(["in_progress"], { repository: "other/repo", id: 4242, attempt: 2 });
  const refused = await readDeploymentLedger(environment, fetcherFor([foreign, success], runReply("completed")), releasing, later);
  assert.match(refused.state === "unresolved" ? refused.reason : "", /run identity names another repository/);
});
