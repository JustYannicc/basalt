import assert from "node:assert/strict";
import test from "node:test";
import { mainCandidateOutputLines, validateMainCandidate, type MainCandidateFetch } from "./main-candidate.ts";

const head = "a".repeat(40);
const other = "b".repeat(40);

function github(main: string, runs: unknown[], pulls: unknown[] = [{ head: { ref: "fix/user-agent" } }]): MainCandidateFetch & { urls: string[] } {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    if (url.endsWith("/commits/main")) return Response.json({ sha: main });
    if (url.endsWith(`/commits/${main}/pulls`)) return Response.json(pulls);
    if (url.includes("/actions/workflows/ci.yml/runs?")) return Response.json({ workflow_runs: runs });
    return new Response(null, { status: 404 });
  };
  return Object.assign(fetcher, { urls });
}

const passing = { head_sha: head, event: "push", conclusion: "success", path: ".github/workflows/ci.yml" };

test("the current main head with a passing push Check is a manual release candidate", async () => {
  const fetcher = github(head, [passing]);
  assert.deepEqual(await validateMainCandidate("owner/basalt", "token", head, undefined, fetcher), { head });
  assert.match(fetcher.urls[1]!, /head_sha=a{40}&event=push&branch=main&status=completed/);
  assert.deepEqual(await validateMainCandidate("owner/basalt", "token", head, head, github(head, [passing])), { head });
  assert.equal(mainCandidateOutputLines({ head }), `head=${head}\n`);
});

test("a stale, unverified or moved main head is refused", async () => {
  const cases: Array<[string, MainCandidateFetch, string | undefined, RegExp]> = [
    ["main moved", github(other, [passing]), undefined, /not the current main head/],
    ["backup for another head", github(head, [passing]), other, /main changed since this manual release was backed up/],
    ["no Check run", github(head, []), undefined, /no successful push Check/],
    ["failed Check", github(head, [{ ...passing, conclusion: "failure" }]), undefined, /no successful push Check/],
    ["pull request Check", github(head, [{ ...passing, event: "pull_request" }]), undefined, /no successful push Check/],
    ["another workflow", github(head, [{ ...passing, path: ".github/workflows/app-lint.yml" }]), undefined, /no successful push Check/],
    ["another commit", github(head, [{ ...passing, head_sha: other }]), undefined, /no successful push Check/],
    ["release update", github(head, [passing], [{ head: { ref: "release-updates/tools-1.2.3" } }]), undefined, /release it through Manual release/],
  ];
  for (const [name, fetcher, expected, error] of cases)
    await assert.rejects(validateMainCandidate("owner/basalt", "token", head, expected, fetcher), error, name);
  await assert.rejects(validateMainCandidate("owner/basalt", "token", "main", undefined, github(head, [passing])), /full commit SHA/);
});
