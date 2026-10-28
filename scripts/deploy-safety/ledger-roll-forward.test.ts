// A release rolls forward over the single failed release since the last success when it contains
// that release's commit. Anything else keeps the ledger unresolved for a person.
import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import { createRecordedBackup } from "./contracts.ts";
import {
  assertReportUsesLatestDeploy,
  beginReleaseDeployment,
  deploymentPayloadFor,
  readDeploymentLedger,
  type DeploymentPayload,
  type RollForward,
} from "./github-ledger.ts";
import { rollForwardTo } from "./release-plan.ts";

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

function transition(base: string, candidate: string, databaseChanged = false): ClassificationReport {
  return {
    schemaVersion: 1,
    base: { gitCommit: base, pins },
    candidate: { gitCommit: candidate, pins },
    databaseChanged,
    workflowChanged: false,
    evidence: {
      database: { state: databaseChanged ? "changed" : "unchanged", sources: [] },
      workflow: { state: "unchanged", sources: [] },
    },
  };
}

/** A release payload; a database-changing one carries its backup like a real manual release. */
function releasePayload(base: string, candidate: string, databaseChanged = false): DeploymentPayload {
  const value = transition(base, candidate, databaseChanged);
  return deploymentPayloadFor(value, "release", databaseChanged ? createRecordedBackup(value, "main", "PS_5", true) : undefined);
}

type Row = { id: number; sha: string; payload: unknown; history: string[] };

// The last success, sha 1, released over sha 0.
const success = (commit = sha("1")): Row =>
  ({ id: 7, sha: commit, payload: releasePayload(sha("0"), commit), history: ["in_progress", "success"] });
// The failed manual release, sha 2 by default, classified as database-changing.
const failed = (history = ["in_progress", "failure"], commit = sha("2"), base = sha("1")): Row =>
  ({ id: 8, sha: commit, payload: releasePayload(base, commit, true), history });

function fetcherFor(rows: Row[], posted: Array<Record<string, unknown>> = []) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (url.pathname.endsWith("/deployments") && method === "GET")
      return Response.json(rows.map(({ id, sha: commit, payload }, index) => ({
        id, sha: commit, environment: "production", payload, created_at: `2026-10-28T1${8 - index}:00:00Z`,
      })));
    if (url.pathname.endsWith("/deployments") && method === "POST") {
      posted.push(body!);
      return Response.json({ id: 9, sha: body!.ref, environment: "production", payload: body!.payload }, { status: 201 });
    }
    const match = /\/deployments\/(\d+)\/statuses$/.exec(url.pathname);
    if (match && method === "POST") return Response.json({ id: 99, state: body!.state }, { status: 201 });
    const row = rows.find(({ id }) => String(id) === match?.[1]);
    // GitHub lists statuses newest first; each history is written oldest first.
    if (row) return Response.json(row.history.map((state, index) => ({
      id: row.id * 10 + index, state, created_at: `2026-10-28T19:0${index}:00Z`,
    })).reverse());
    throw new Error(`Unexpected GitHub fixture request: ${method} ${url.pathname}`);
  };
}

/** A release of sha 3 whose history contains exactly `ancestors`, recording each question. */
function releasing(ancestors: string[] = [sha("2")], candidate = sha("3")) {
  const calls: string[] = [];
  const rollForward: RollForward = {
    candidateGitCommit: candidate,
    contains: (ancestor, descendant) => {
      calls.push(`${ancestor.slice(0, 1)}<=${descendant.slice(0, 1)}`);
      return ancestor === descendant || ancestors.includes(ancestor);
    },
  };
  return Object.assign(rollForward, { calls });
}

test("one failed release the next release contains is rolled forward over", async () => {
  for (const status of ["failure", "error"]) {
    const next = releasing();
    const ledger = await readDeploymentLedger(environment, fetcherFor([failed(["in_progress", status]), success()]), next);
    assert.equal(ledger.state, "ready", status);
    if (ledger.state !== "ready") continue;
    assert.equal(ledger.gitCommit, sha("1"));
    assert.equal(ledger.deploymentId, 7);
    assert.deepEqual(ledger.superseded, { deploymentId: 8, gitCommit: sha("2"), deploymentStatus: status });
    assert.deepEqual(next.calls, ["2<=3"]);
    // The next release is classified from the last success, so its report passes the guard.
    assert.doesNotThrow(() => assertReportUsesLatestDeploy(transition(sha("1"), sha("3")), ledger));
  }
  // Re-releasing the failed commit itself also rolls forward.
  const again = await readDeploymentLedger(environment, fetcherFor([failed(), success()]), releasing([], sha("2")));
  assert.equal(again.state, "ready");
});

test("a second failure since the last success stays unresolved for a person", async () => {
  const second: Row = { id: 9, sha: sha("3"), payload: releasePayload(sha("1"), sha("3")), history: ["in_progress", "failure"] };
  const next = releasing([sha("2"), sha("3")], sha("4"));
  const ledger = await readDeploymentLedger(environment, fetcherFor([second, failed(), success()]), next);
  assert.equal(ledger.state, "unresolved");
  assert.match(ledger.state === "unresolved" ? ledger.supersedeRefusal ?? "" : "", /2 deployment records follow the last success/);
  assert.deepEqual(next.calls, [], "ancestry is never asked");
});

test("a failed release the next release doesn't contain stays unresolved", async () => {
  // Another branch, or main rewritten after the failed release.
  const ledger = await readDeploymentLedger(environment, fetcherFor([failed(), success()]), releasing([]));
  assert.equal(ledger.state, "unresolved");
  assert.match(ledger.state === "unresolved" ? ledger.supersedeRefusal ?? "" : "", /is not contained in 3{40}/);
  assert.throws(() => assertReportUsesLatestDeploy(transition(sha("1"), sha("3")), ledger), /unresolved \(failure\).*not superseded: deployment 8/);

  // Git that can't answer fails closed.
  const broken: RollForward = { candidateGitCommit: sha("3"), contains: () => { throw new Error("fatal: Not a valid commit name"); } };
  const unanswered = await readDeploymentLedger(environment, fetcherFor([failed(), success()]), broken);
  assert.equal(unanswered.state, "unresolved");
  assert.match(unanswered.state === "unresolved" ? unanswered.supersedeRefusal ?? "" : "", /could not be checked/);

  // Without a release asking, as on every rollback path, the failure is still there.
  assert.equal((await readDeploymentLedger(environment, fetcherFor([failed(), success()]))).state, "unresolved");
});

test("pending, in-progress, status-less, inactive and once-successful records still block", async () => {
  for (const history of [["in_progress"], ["pending"], ["queued"], [], ["in_progress", "inactive"], ["in_progress", "success", "failure"]]) {
    const next = releasing();
    const ledger = await readDeploymentLedger(environment, fetcherFor([failed(history), success()]), next);
    assert.equal(ledger.state, "unresolved", JSON.stringify(history));
    assert.deepEqual(next.calls, [], JSON.stringify(history));
  }
});

test("rollback records and releases from another base still block", async () => {
  const rollback = { ...deploymentPayloadFor(transition(sha("1"), sha("2")), "rollback"), rollbackOf: sha("2") };
  const rolledBack: Row = { id: 8, sha: sha("1"), payload: rollback, history: ["in_progress", "failure"] };
  assert.equal((await readDeploymentLedger(environment, fetcherFor([rolledBack, success()]), releasing([sha("1")]))).state, "unresolved");

  const ledger = await readDeploymentLedger(environment, fetcherFor([failed(undefined, sha("2"), sha("5")), success()]), releasing());
  assert.equal(ledger.state, "unresolved");
  assert.match(ledger.state === "unresolved" ? ledger.supersedeRefusal ?? "" : "", /not based on the last successful deployment/);
});

test("rolling forward is rechecked when the next release begins", async () => {
  const next = transition(sha("1"), sha("3"));
  await assert.rejects(beginReleaseDeployment(next, environment, fetcherFor([failed(), success()])), /unresolved/);
  await assert.rejects(beginReleaseDeployment(next, environment, fetcherFor([failed(), success()]), undefined, releasing([])), /not superseded/);

  const posted: Array<Record<string, unknown>> = [];
  assert.equal(await beginReleaseDeployment(next, environment, fetcherFor([failed(), success()], posted), undefined, releasing()), 9);
  const payload = posted[0]!.payload as DeploymentPayload;
  assert.equal(posted[0]!.ref, sha("3"));
  assert.equal(payload.baseGitCommit, sha("1"));
  assert.equal(payload.candidateGitCommit, sha("3"));
});

// The manual release of 2a2bc67 failed on 2 of 10 Worker uploads after b2b64e2 had succeeded.
const realSuccess = "b2b64e2fae8dd1ad025a063b9bff06158cf4f5ea";
const realFailure = "2a2bc679f6e584a985e1139ee42d219513d365f5";
const realNext = "b2781c675f07bb83d28c1f7f583e371ad9de4d65";

test("a release of b2781c6 rolls forward over the failed 2a2bc67 release, using real Git ancestry", async () => {
  const rows = [failed(undefined, realFailure, realSuccess), success(realSuccess)];
  const ledger = await readDeploymentLedger(environment, fetcherFor(rows), rollForwardTo(realNext));
  assert.equal(ledger.state, "ready");
  assert.equal(ledger.state === "ready" ? ledger.gitCommit : "", realSuccess);
  assert.equal(ledger.state === "ready" ? ledger.superseded?.gitCommit : "", realFailure);

  // An older commit does not contain the failed release.
  const older = await readDeploymentLedger(environment, fetcherFor(rows), rollForwardTo(realSuccess));
  assert.equal(older.state, "unresolved");
  // A commit Git can't find fails closed.
  const missing = await readDeploymentLedger(environment, fetcherFor(rows), rollForwardTo(sha("f")));
  assert.equal(missing.state, "unresolved");
  assert.match(missing.state === "unresolved" ? missing.supersedeRefusal ?? "" : "", /could not be checked/);
  assert.throws(() => rollForwardTo(realNext).contains("not-a-sha", realNext), /exact commit SHAs/);
});
