import assert from "node:assert/strict";
import test from "node:test";
import { mainCandidateOutputLines, validateMainCandidate, type MainCandidateFetch } from "./main-candidate.ts";

const head = "a".repeat(40);
const other = "b".repeat(40);
const newer = "c".repeat(40);

function github(
  main: string,
  runs: unknown[],
  pulls: unknown[] = [{ head: { ref: "fix/user-agent" } }],
  comparison = "ahead",
): MainCandidateFetch & { urls: string[] } {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    if (url.endsWith("/commits/main")) return Response.json({ sha: main });
    if (url.endsWith(`/commits/${head}/pulls`)) return Response.json(pulls);
    if (url.includes(`/compare/${head}...${main}?`) && comparison !== "missing") return Response.json({ status: comparison });
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
  assert.ok(!fetcher.urls.some((url) => url.includes("/compare/")));
  assert.equal(mainCandidateOutputLines({ head }), `head=${head}\n`);
});

test("a candidate main has moved past is still a manual release candidate", async () => {
  // The backup job checks out a newer main; the deploy job rechecks the backed-up candidate the same way.
  const fetcher = github(newer, [passing]);
  assert.deepEqual(await validateMainCandidate("owner/basalt", "token", newer, head, fetcher), { head });
  assert.ok(fetcher.urls.some((url) => url.includes(`/compare/${head}...${newer}?`)));
  assert.match(fetcher.urls.find((url) => url.includes("/ci.yml/runs?"))!, /head_sha=a{40}&event=push/);
  assert.deepEqual(await validateMainCandidate("owner/basalt", "token", newer, head.toUpperCase(), github(newer, [passing], undefined, "identical")), { head });
  assert.deepEqual(await validateMainCandidate("owner/basalt", "token", head, head, github(head, [passing], undefined, "behind")), { head });
});

test("a stale, unverified or moved main head is refused", async () => {
  const cases: Array<[string, MainCandidateFetch, RegExp]> = [
    ["main moved", github(other, [passing]), /not the current main head/],
    ["no Check run", github(head, []), /no successful push Check/],
    ["failed Check", github(head, [{ ...passing, conclusion: "failure" }]), /no successful push Check/],
    ["pull request Check", github(head, [{ ...passing, event: "pull_request" }]), /no successful push Check/],
    ["another workflow", github(head, [{ ...passing, path: ".github/workflows/app-lint.yml" }]), /no successful push Check/],
    ["another commit", github(head, [{ ...passing, head_sha: other }]), /no successful push Check/],
    ["release update", github(head, [passing], [{ head: { ref: "release-updates/tools-1.2.3" } }]), /release it through Manual release/],
  ];
  for (const [name, fetcher, error] of cases)
    await assert.rejects(validateMainCandidate("owner/basalt", "token", head, undefined, fetcher), error, name);
  await assert.rejects(validateMainCandidate("owner/basalt", "token", "main", undefined, github(head, [passing])), /full commit SHA/);
});

test("a candidate main doesn't contain, or that isn't a passing non-update commit, is refused", async () => {
  const cases: Array<[string, MainCandidateFetch, RegExp]> = [
    ["main rewritten past it", github(newer, [passing], undefined, "diverged"), /main does not contain the release candidate/],
    ["newer than main", github(newer, [passing], undefined, "behind"), /main does not contain the release candidate/],
    ["commit GitHub can't compare", github(newer, [passing], undefined, "missing"), /HTTP 404/],
    ["no Check run", github(newer, []), /no successful push Check/],
    ["failed Check", github(newer, [{ ...passing, conclusion: "failure" }]), /no successful push Check/],
    ["release update", github(newer, [passing], [{ head: { ref: "release-updates/tools-1.2.3" } }]), /release it through Manual release/],
  ];
  for (const [name, fetcher, error] of cases)
    await assert.rejects(validateMainCandidate("owner/basalt", "token", newer, head, fetcher), error, name);
  for (const candidate of ["", "main", head.slice(0, 12), `${head}0`])
    await assert.rejects(validateMainCandidate("owner/basalt", "token", newer, candidate, github(newer, [passing])), /release candidate must be a full commit SHA/, candidate);
});
