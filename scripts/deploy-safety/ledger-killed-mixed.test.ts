// A release job killed hard after failed attempts of other commits. Rolling forward over its
// record writes nothing back, so the record stays unfinished under every later attempt.
import assert from "node:assert/strict";
import test from "node:test";
import type { ClassificationReport, ReleasePins } from "../releases/types.ts";
import {
  deploymentPayloadFor,
  KILLED_RUN_GRACE_MS,
  readDeploymentLedger,
  type DeploymentLedger,
  type DeploymentPayload,
  type RollForward,
  type RunIdentity,
} from "./github-ledger.ts";

const sha = (character: string) => character.repeat(40);
const repository = "owner/repo";
const environment = { token: "fixture-token", repository };
const api = `https://api.github.com/repos/${repository}`;
const asset = {
  amd64: { name: "amd64", sha256: "c".repeat(64) },
  arm64: { name: "arm64", sha256: "d".repeat(64) },
};
const pins: ReleasePins = {
  tools: { repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: sha("a") },
  home: {
    repository: "https://github.com/router-for-me/CLIProxyAPIHome.git",
    tag: "v1",
    commit: sha("b"),
    binary: "home",
    assets: asset,
  },
  node: {
    repository: "https://github.com/router-for-me/CLIProxyAPI.git",
    tag: "v1",
    commit: sha("e"),
    binary: "node",
    assets: asset,
  },
};

function payloadOf(base: string, candidate: string, run?: RunIdentity): DeploymentPayload {
  const report: ClassificationReport = {
    schemaVersion: 1,
    base: { gitCommit: base, pins },
    candidate: { gitCommit: candidate, pins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: {
      database: { state: "unchanged", sources: [] },
      workflow: { state: "unchanged", sources: [] },
    },
  };
  return { ...deploymentPayloadFor(report), ...(run ? { run } : {}) };
}

type Run = RunIdentity & { status: string; conclusion: string | null; updatedAt: string };
type Row = { id: number; sha: string; createdAt: string; payload: unknown; history: string[] };

const success: Row = {
  id: 7,
  sha: sha("1"),
  createdAt: "2026-11-18T08:00:00Z",
  payload: payloadOf(sha("0"), sha("1")),
  history: ["in_progress", "success"],
};
// Another commit's attempt that recorded its own failure, like the production chain today.
const otherFailed: Row = {
  id: 8,
  sha: sha("2"),
  createdAt: "2026-11-18T10:00:00Z",
  payload: payloadOf(sha("1"), sha("2")),
  history: ["in_progress", "failure"],
};
const r3Run = { repository, id: 4303, attempt: 1 };
const killedR3: Row = {
  id: 9,
  sha: sha("3"),
  createdAt: "2026-11-18T12:00:00Z",
  payload: payloadOf(sha("1"), sha("3"), r3Run),
  history: ["in_progress"],
};
// r4 rolled forward over the killed r3, then failed and said so.
const failedR4: Row = {
  id: 10,
  sha: sha("4"),
  createdAt: "2026-11-18T14:00:00Z",
  payload: payloadOf(sha("1"), sha("4"), { repository, id: 4304, attempt: 1 }),
  history: ["in_progress", "failure"],
};
const r3Cancelled: Run = {
  ...r3Run,
  status: "completed",
  conclusion: "cancelled",
  updatedAt: "2026-11-18T12:40:00Z",
};
const r3Running: Run = {
  ...r3Run,
  status: "in_progress",
  conclusion: null,
  updatedAt: "2026-11-18T12:40:00Z",
};
const longAfter = () => Date.parse("2026-11-18T16:00:00Z");

const user = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
const time = (base: string, minutes: number) =>
  new Date(Date.parse(base) + minutes * 60_000).toISOString().replace(".000Z", "Z");

/** The REST shapes GitHub returns, newest first, one page per `page` query, and nothing but GETs. */
function github(rows: Row[], runs: Run[], requests: string[] = []) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (method !== "GET") return Response.json({ message: "Not Found" }, { status: 404 });
    const page = Number(url.searchParams.get("page") ?? "1");
    const paged = <T>(items: T[]) => Response.json(page === 1 ? items : []);
    if (url.pathname === `/repos/${repository}/deployments`)
      return paged(
        [...rows]
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
          .map((row) => ({
            url: `${api}/deployments/${row.id}`,
            id: row.id,
            node_id: `DE_${row.id}`,
            sha: row.sha,
            ref: row.sha,
            task: "deploy",
            payload: row.payload,
            original_environment: "production",
            environment: "production",
            description: null,
            creator: user,
            created_at: row.createdAt,
            updated_at: time(row.createdAt, row.history.length),
            statuses_url: `${api}/deployments/${row.id}/statuses`,
            repository_url: api,
            transient_environment: false,
            production_environment: true,
          })),
      );
    const statuses = /^\/repos\/owner\/repo\/deployments\/(\d+)\/statuses$/.exec(url.pathname);
    const row = rows.find(({ id }) => String(id) === statuses?.[1]);
    if (row)
      return paged(
        row.history
          .map((state, index) => ({
            url: `${api}/deployments/${row.id}/statuses/${row.id * 10 + index}`,
            id: row.id * 10 + index,
            node_id: `DES_${row.id * 10 + index}`,
            state,
            creator: user,
            description: "",
            environment: "production",
            target_url: "",
            log_url: "",
            created_at: time(row.createdAt, index + 1),
            updated_at: time(row.createdAt, index + 1),
            deployment_url: `${api}/deployments/${row.id}`,
            repository_url: api,
          }))
          .reverse(),
      );
    const attempt = /^\/repos\/owner\/repo\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(
      url.pathname,
    );
    const run = runs.find(
      ({ id, attempt: n }) => `${id}/${n}` === `${attempt?.[1]}/${attempt?.[2]}`,
    );
    if (run)
      return Response.json({
        id: run.id,
        name: "Deploy",
        node_id: `WFR_${run.id}`,
        head_branch: "main",
        head_sha: sha("3"),
        path: ".github/workflows/deploy.yml",
        run_number: run.id - 4000,
        event: "push",
        status: run.status,
        conclusion: run.conclusion,
        workflow_id: 1,
        url: `${api}/actions/runs/${run.id}`,
        html_url: `https://github.com/${repository}/actions/runs/${run.id}`,
        created_at: "2026-11-18T12:00:00Z",
        updated_at: run.updatedAt,
        run_attempt: run.attempt,
        run_started_at: "2026-11-18T12:00:00Z",
        repository: { id: 1, name: "repo", full_name: repository, private: false },
      });
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

const releasing = (candidate: string): RollForward => ({
  candidateGitCommit: candidate,
  contains: () => true,
});
const why = (ledger: DeploymentLedger) =>
  ledger.state === "unresolved" ? `${ledger.reason}; ${ledger.supersedeRefusal}` : "";

test("a killed latest attempt after another commit's failure rolls forward once its run completed", async () => {
  const requests: string[] = [];
  const rows = [killedR3, otherFailed, success];
  const ledger = await readDeploymentLedger(
    environment,
    github(rows, [r3Cancelled], requests),
    releasing(sha("4")),
    longAfter,
  );
  assert.equal(ledger.state, "ready", why(ledger));
  assert.deepEqual(
    ledger.state === "ready"
      ? ledger.supersededAttempts?.map(({ deploymentId }) => deploymentId)
      : [],
    [9, 8],
  );
  assert.deepEqual(
    requests.filter((request) => !request.startsWith("GET ")),
    [],
  );
});

test("a killed attempt under a later failed one still rolls forward", async () => {
  const ledger = await readDeploymentLedger(
    environment,
    github([failedR4, killedR3, otherFailed, success], [r3Cancelled]),
    releasing(sha("5")),
    longAfter,
  );
  assert.equal(ledger.state, "ready", why(ledger));
  assert.equal(ledger.state === "ready" ? ledger.supersededAttempts?.length : 0, 3);
});

test("a killed attempt in a mixed chain stays blocked while its run is running or in grace", async () => {
  const inGrace = () => Date.parse(r3Cancelled.updatedAt) + KILLED_RUN_GRACE_MS - 1;
  for (const [rows, run, now, expected] of [
    [[killedR3, otherFailed, success], r3Running, longAfter, /is still in_progress/],
    [[failedR4, killedR3, otherFailed, success], r3Running, longAfter, /is still in_progress/],
    [[killedR3, otherFailed, success], r3Cancelled, inGrace, /within the 15-minute grace period/],
    [
      [failedR4, killedR3, otherFailed, success],
      r3Cancelled,
      inGrace,
      /within the 15-minute grace period/,
    ],
  ] as const) {
    const ledger = await readDeploymentLedger(
      environment,
      github([...rows], [run]),
      releasing(sha("5")),
      now,
    );
    assert.equal(ledger.state, "unresolved");
    assert.match(
      ledger.state === "unresolved" ? (ledger.supersedeRefusal ?? "") : "",
      new RegExp(`deployment 9 is in_progress, .*${expected.source}`),
    );
  }
});
