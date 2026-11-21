import assert from "node:assert/strict";
import test from "node:test";
import { sha } from "../releases/fixtures.test-helpers.ts";
import type { MainCandidateFetch } from "./main-candidate.ts";
import { rehearsalGate } from "./rehearsal-gate.ts";

const head = sha("a");
const other = sha("b");
const run = (workflow: string, overrides: Record<string, unknown> = {}) => ({
  head_sha: head,
  event: "push",
  conclusion: "success",
  path: `.github/workflows/${workflow}`,
  ...overrides,
});

function github(check: unknown[], rehearsal: unknown[]): MainCandidateFetch & { urls: string[] } {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    if (url.includes("/actions/workflows/ci.yml/runs?"))
      return Response.json({ workflow_runs: check });
    if (url.includes("/actions/workflows/release-rehearsal.yml/runs?"))
      return Response.json({ workflow_runs: rehearsal });
    return new Response(null, { status: 404 });
  };
  return Object.assign(fetcher, { urls });
}

const env = {
  GITHUB_TOKEN: "token",
  GITHUB_REPOSITORY: "owner/basalt",
  RELEASE_CANDIDATE_SHA: head,
};

test("a candidate is ready only when its push Check and rehearsal both passed on it", async () => {
  const fetcher = github([run("ci.yml")], [run("release-rehearsal.yml")]);
  assert.deepEqual(await rehearsalGate(env, "require", fetcher), { ready: true });
  const rehearsalQuery = new URL(fetcher.urls.find((url) => url.includes("release-rehearsal.yml"))!)
    .searchParams;
  assert.equal(rehearsalQuery.get("head_sha"), head);
  assert.equal(rehearsalQuery.get("event"), "push");
  assert.equal(rehearsalQuery.get("branch"), "main");
});

test("a missing, failed, foreign or pull request rehearsal keeps production closed", async () => {
  const cases: Array<[string, unknown[], unknown[], RegExp]> = [
    ["no rehearsal", [run("ci.yml")], [], /no passed release rehearsal/],
    [
      "failed",
      [run("ci.yml")],
      [run("release-rehearsal.yml", { conclusion: "failure" })],
      /no passed release rehearsal/,
    ],
    [
      "cancelled",
      [run("ci.yml")],
      [run("release-rehearsal.yml", { conclusion: "cancelled" })],
      /no passed release rehearsal/,
    ],
    [
      "pull request",
      [run("ci.yml")],
      [run("release-rehearsal.yml", { event: "pull_request" })],
      /no passed release rehearsal/,
    ],
    [
      "another commit",
      [run("ci.yml")],
      [run("release-rehearsal.yml", { head_sha: other })],
      /no passed release rehearsal/,
    ],
    [
      "another workflow",
      [run("ci.yml")],
      [run("release-preview.yml")],
      /no passed release rehearsal/,
    ],
    ["no Check", [], [run("release-rehearsal.yml")], /no successful push Check/],
  ];
  for (const [name, check, rehearsal, error] of cases) {
    await assert.rejects(rehearsalGate(env, "require", github(check, rehearsal)), error, name);
    assert.deepEqual(
      await rehearsalGate(env, "ready", github(check, rehearsal)),
      { ready: false },
      name,
    );
  }
});

test("the gate refuses without a full candidate, a token or a mode", async () => {
  const fetcher = github([run("ci.yml")], [run("release-rehearsal.yml")]);
  await assert.rejects(
    rehearsalGate({ ...env, RELEASE_CANDIDATE_SHA: "main" }, "require", fetcher),
    /full commit SHA/,
  );
  await assert.rejects(
    rehearsalGate({ ...env, GITHUB_TOKEN: undefined }, "require", fetcher),
    /GITHUB_TOKEN/,
  );
  await assert.rejects(rehearsalGate(env, undefined, fetcher), /usage/);
  await assert.rejects(
    rehearsalGate(env, "require", async () => new Response(null, { status: 502 })),
    /HTTP 502/,
  );
});
