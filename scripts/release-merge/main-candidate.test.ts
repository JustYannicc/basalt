import assert from "node:assert/strict";
import test from "node:test";
import { sha } from "../releases/fixtures.test-helpers.ts";
import { mainCandidateOutputLines, newerMainCandidate, validateMainCandidate, type MainCandidateFetch } from "./main-candidate.ts";

const head = sha("a");
const other = sha("b");
const newer = sha("c");

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

/**
 * main is `head` followed by `after`, oldest first. A newer commit's Check passed unless `checks`
 * names its conclusion, or undefined for one still running. `pages` splits head...tip as GitHub would.
 */
function mainAfter(after: string[], checks: Record<string, string | undefined> = {}, updates: string[] = [], options: { sideBranch?: string; pages?: string[][] } = {}) {
  const order = [head, ...after];
  const tip = order.at(-1)!;
  const urls: string[] = [];
  const fetcher: MainCandidateFetch = async (url) => {
    urls.push(url);
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/commits/main")) return Response.json({ sha: tip });
    const compare = pathname.match(/\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/);
    if (compare) {
      const [from, to] = [order.indexOf(compare[1]!), order.indexOf(compare[2]!)];
      const status = from < 0 || to < from || compare[2] === options.sideBranch ? "diverged" : from === to ? "identical" : "ahead";
      const paged = options.pages && from === 0 && compare[2] === tip;
      const commits = paged ? options.pages![Number(searchParams.get("page")) - 1]! : order.slice(from + 1, to + 1);
      return Response.json({ status, total_commits: paged ? 101 : commits.length, commits: commits.map((sha) => ({ sha })) });
    }
    const pulls = pathname.match(/\/commits\/([a-f0-9]{40})\/pulls$/);
    if (pulls) return Response.json([{ head: { ref: updates.includes(pulls[1]!) ? "release-updates/tools-1.2.3" : "fix/user-agent" } }]);
    if (pathname.endsWith("/actions/workflows/ci.yml/runs")) {
      const commit = searchParams.get("head_sha")!;
      const conclusion = commit in checks ? checks[commit] : "success";
      return Response.json({ workflow_runs: conclusion ? [{ ...passing, head_sha: commit, conclusion }] : [] });
    }
    return new Response(null, { status: 404 });
  };
  return Object.assign(fetcher, { urls });
}

const [n1, n2, n3] = [sha("1"), sha("2"), sha("3")];

test("a release for a candidate main has moved past releases the newest passing commit containing it", async () => {
  const newest = (fetcher: MainCandidateFetch) => newerMainCandidate("owner/basalt", "token", head, fetcher);
  // n3's Check is still running, so n2 is the newest commit that can be released.
  assert.equal(await newest(mainAfter([n1, n2, n3], { [n3]: undefined })), n2);
  assert.equal(await newest(mainAfter([n1, n2, n3], { [n3]: "failure" }, [n2])), n1);
  assert.equal(await newest(mainAfter([n1, n2, n3], { [n3]: undefined }, [], { sideBranch: n2 })), n1);
  // GitHub lists the oldest commits first, so the newest come from the last page.
  const paged = mainAfter([n1, n2, n3], {}, [], { pages: [[n1, n2], [n3]] });
  assert.equal(await newest(paged), n3);
  assert.deepEqual(paged.urls.filter((url) => url.includes(`...${n3}?`)).map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);
});

test("the candidate itself is released when nothing newer on main qualifies", async () => {
  const newest = (fetcher: MainCandidateFetch, candidate = head) => newerMainCandidate("owner/basalt", "token", candidate, fetcher);
  assert.equal(await newest(mainAfter([n1, n2], { [n1]: "failure", [n2]: undefined })), undefined);
  assert.equal(await newest(mainAfter([n1], {}, [n1])), undefined);
  const atHead = mainAfter([]);
  assert.equal(await newest(atHead), undefined);
  assert.ok(!atHead.urls.some((url) => url.includes("/compare/")));
  await assert.rejects(newest(mainAfter([n1]), n3), /main does not contain the release candidate/);
  await assert.rejects(newest(mainAfter([n1]), "main"), /full commit SHA/);
});
