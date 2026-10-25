import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClassificationReport } from "../releases/types.ts";
import { deploymentPayloadFor } from "./github-ledger.ts";
import { currentCommit, gitRepositoryRoot, latestProductionBase } from "./release-plan.ts";

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
    databases = [{ name: "basalt", kind: "postgresql", ready: true, default_branch: "main" }];
    await assert.rejects(latestProductionBase(), /PlanetScale database already exists/);
    databases = [];
    assert.deepEqual(await latestProductionBase(), { state: "uninitialized" });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) restore(name, value);
  }
});
