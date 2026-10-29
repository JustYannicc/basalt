import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pins as fixturePins, sha } from "../releases/fixtures.test-helpers.ts";
import type { ClassificationReport } from "../releases/types.ts";
import type { PinSummary } from "./contracts.ts";
import { deploymentPayloadFor, type DeploymentPayload } from "./github-ledger.ts";
import { currentCommit, gitRepositoryRoot, latestProductionBase, liveCommitContaining, productionCommitContaining } from "./release-plan.ts";

test("candidate SHA comes from checked-out HEAD, not workflow_dispatch GITHUB_SHA", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-candidate-sha-"));
  const prior = {
    githubSha: process.env.GITHUB_SHA,
    candidateSha: process.env.BASALT_RELEASE_CANDIDATE_SHA,
  };
  try {
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
    execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(root, "candidate.txt"), "candidate\n");
    execFileSync("git", ["-C", root, "add", "candidate.txt"]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "candidate"]);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    process.env.GITHUB_SHA = "f".repeat(40);
    process.env.BASALT_RELEASE_CANDIDATE_SHA = head;
    assert.equal(currentCommit(root), head);
    process.env.BASALT_RELEASE_CANDIDATE_SHA = "e".repeat(40);
    assert.throws(() => currentCommit(root), /does not match the checked-out HEAD/);
  } finally {
    restore("GITHUB_SHA", prior.githubSha);
    restore("BASALT_RELEASE_CANDIDATE_SHA", prior.candidateSha);
    rmSync(root, { recursive: true, force: true });
  }
});

test("release classifier source root stays on the trusted runner checkout", () => {
  const trustedRoot = realpathSync(gitRepositoryRoot());
  const candidateRoot = mkdtempSync(join(tmpdir(), "basalt-candidate-source-"));
  const previousDirectory = process.cwd();
  try {
    process.chdir(candidateRoot);
    assert.equal(realpathSync(gitRepositoryRoot()), trustedRoot);
    assert.notEqual(realpathSync(process.cwd()), trustedRoot);
  } finally {
    process.chdir(previousDirectory);
    rmSync(candidateRoot, { recursive: true, force: true });
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("a retry after failed initial attempts still requires the production database to be absent", async () => {
  const names = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "PLANETSCALE_ORGANIZATION", "PLANETSCALE_API_TOKEN_ID", "PLANETSCALE_API_TOKEN"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    GITHUB_TOKEN: "fixture-token",
    GITHUB_REPOSITORY: "owner/repo",
    PLANETSCALE_ORGANIZATION: "basalt-org",
    PLANETSCALE_API_TOKEN_ID: "fixture-id",
    PLANETSCALE_API_TOKEN: "fixture-secret",
  });
  const list = (data: unknown[]) => Response.json({
    type: "list", current_page: 1, per_page: 100, next_page: null,
    total_count: data.length, total_pages: data.length ? 1 : 0, data,
  });
  const candidate = "2".repeat(40);
  const asset = (name: string, digit: string) => ({ name, sha256: digit.repeat(64) });
  const pins = {
    tools: { repository: "https://github.com/UsefulSoftwareCo/executor.git", commit: "a".repeat(40) },
    home: { repository: "https://github.com/router-for-me/CLIProxyAPIHome.git", tag: "v1", commit: "b".repeat(40), binary: "home", assets: { amd64: asset("amd64", "c"), arm64: asset("arm64", "d") } },
    node: { repository: "https://github.com/router-for-me/CLIProxyAPI.git", tag: "v1", commit: "e".repeat(40), binary: "node", assets: { amd64: asset("amd64", "f"), arm64: asset("node-arm64", "0") } },
  };
  const initial: ClassificationReport = {
    schemaVersion: 1,
    base: { gitCommit: candidate, pins },
    candidate: { gitCommit: candidate, pins },
    databaseChanged: false,
    workflowChanged: false,
    evidence: { database: { state: "unchanged", sources: [] }, workflow: { state: "unchanged", sources: [] } },
  };
  let databases: unknown[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.planetscale.com") return list(databases);
    if (url.pathname.endsWith("/deployments"))
      return Response.json([{ id: 3, sha: candidate, environment: "production", payload: deploymentPayloadFor(initial), created_at: "2026-10-25T16:00:00Z" }]);
    if (url.pathname.endsWith("/deployments/3/statuses"))
      return Response.json([
        { id: 31, state: "failure", created_at: "2026-10-25T16:05:00Z" },
        { id: 30, state: "in_progress", created_at: "2026-10-25T16:00:00Z" },
      ]);
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  try {
    const basalt = { name: "basalt", kind: "postgresql", ready: true, default_branch: "main" };
    databases = [{ ...basalt, created_at: "2026-10-25T15:59:59Z" }];
    await assert.rejects(latestProductionBase(), /PlanetScale database already exists/);
    databases = [basalt];
    await assert.rejects(latestProductionBase(), /PlanetScale database already exists/);
    databases = [{ ...basalt, created_at: "2026-10-25T16:06:00Z" }];
    await assert.rejects(latestProductionBase(), /PlanetScale database already exists/);
    databases = [{ ...basalt, created_at: "2026-10-25T16:01:00Z" }];
    assert.deepEqual(await latestProductionBase(), { state: "uninitialized" });
    databases = [];
    assert.deepEqual(await latestProductionBase(), { state: "uninitialized" });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) restore(name, value);
  }
});

test("production already containing a candidate stops its release, including after a pull request release", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "basalt-already-live-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd: string, name: string) => {
    writeFileSync(join(cwd, name), `${name}\n`);
    git(cwd, "add", name);
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", name);
    return git(cwd, "rev-parse", "HEAD");
  };
  const origin = join(root, "origin");
  const checkout = join(root, "checkout");
  const previous = new Map(["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"].map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", origin]);
    const older = commit(origin, "older");
    const deployed = commit(origin, "deployed");
    execFileSync("git", ["clone", "--quiet", origin, checkout]);
    const newer = commit(checkout, "newer");
    // A `Manual release` of a pull request leaves production on a head the main checkout never fetched.
    git(origin, "switch", "--quiet", "-c", "release-updates/tools");
    const pullHead = commit(origin, "pull-head");
    assert.throws(() => git(checkout, "cat-file", "-e", `${pullHead}^{commit}`));

    Object.assign(process.env, { GITHUB_TOKEN: "fixture-token", GITHUB_REPOSITORY: "owner/repo" });
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    const pins = fixturePins();
    let live = deployed;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const report: ClassificationReport = {
        schemaVersion: 1,
        base: { gitCommit: older, pins },
        candidate: { gitCommit: live, pins },
        databaseChanged: false,
        workflowChanged: false,
        evidence: { database: { state: "unchanged", sources: [] }, workflow: { state: "unchanged", sources: [] } },
      };
      if (url.pathname.endsWith("/deployments"))
        return Response.json([{ id: 9, sha: live, environment: "production", payload: deploymentPayloadFor(report), created_at: "2026-10-29T12:00:00Z" }]);
      if (url.pathname.endsWith("/deployments/9/statuses"))
        return Response.json([{ id: 91, state: "success", created_at: "2026-10-29T12:05:00Z" }]);
      throw new Error(`Unexpected fixture request: ${url}`);
    };

    assert.equal(await productionCommitContaining(deployed, checkout), deployed);
    assert.equal(await productionCommitContaining(older, checkout), deployed);
    assert.equal(await productionCommitContaining(newer, checkout), undefined);
    live = pullHead;
    assert.equal(await productionCommitContaining(older, checkout), pullHead);
    assert.equal(await productionCommitContaining(newer, checkout), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) restore(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the last successful production commit decides whether a candidate is already live", () => {
  const [candidate, live, failed] = [sha("1"), sha("2"), sha("3")];
  const asked: Array<[string, string]> = [];
  const contains = (ancestor: string, descendant: string) => {
    asked.push([ancestor, descendant]);
    return descendant === live;
  };
  const pins = {} as PinSummary;
  const payload = {} as DeploymentPayload;
  assert.equal(liveCommitContaining(candidate, { state: "uninitialized" }, contains), undefined);
  assert.equal(liveCommitContaining(candidate, { state: "ready", deploymentId: 1, gitCommit: live, pins, payload }, contains), live);
  assert.equal(liveCommitContaining(live, { state: "ready", deploymentId: 1, gitCommit: live, pins, payload }, () => assert.fail("same commit")), live);
  // A failed release after the success isn't live; the success before it is.
  const unresolved = { state: "unresolved", deploymentId: 2, gitCommit: failed, deploymentStatus: "failure", reason: "failed" } as const;
  assert.equal(liveCommitContaining(candidate, { ...unresolved, lastSuccessful: { deploymentId: 1, gitCommit: live, pins } }, contains), live);
  assert.equal(liveCommitContaining(candidate, unresolved, contains), undefined);
  assert.deepEqual(asked, [[candidate, live], [candidate, live]]);
});
