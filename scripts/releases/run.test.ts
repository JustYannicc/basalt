import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { releases, makeReleaseRoot, sha } from "./fixtures.test-helpers.ts";
import { runReleaseUpdate, releaseBuildEnvironment, type ReleaseUpdateApi } from "./run.ts";

test("reconciles a failed candidate preparation and keeps its details out of PR metadata", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const commands: string[] = [];
  let captured: { failure: string | undefined; source: string; changedPaths: string[] } | undefined;
  const privateFailure = "GH token ghp_123456789012345678901234567890 /Users/runner/private/build.log";
  const api = {
    async get(path: string) {
      if (path === "repos/router-for-me/CLIProxyAPI/releases/latest") return releases("node", "8.0.41", "4");
      if (path === "repos/router-for-me/CLIProxyAPI/commits/v8.0.41") return { sha: sha("e") };
      throw new Error(`Unexpected mocked request: ${path}`);
    },
    async request() { return undefined; },
    async compare() { return { complete: true, status: "identical" as const, aheadBy: 0, behindBy: 0, files: [] }; },
    async compareTrees() { return { complete: true, status: "diverged" as const, aheadBy: 0, behindBy: 0, files: [] }; },
  } as unknown as ReleaseUpdateApi;

  const result = await runReleaseUpdate(root, "node", "release-token", {
    api,
    repository: "owner/repository",
    resetMain: () => sha("1"),
    runCommand: (_root, step) => {
      commands.push(step);
      if (step === "build the pinned hosted framework") throw new Error(privateFailure);
    },
    reconcile: async (_root, repository, source, plan, token, failure) => {
      assert.equal(repository, "owner/repository");
      assert.equal(source, "node");
      assert.equal(token, "release-token");
      assert.equal(JSON.parse(readFileSync(join(root, "containers/pool/releases.json"), "utf8")).artifacts.node.tag, "v8.0.41");
      captured = { failure, source, changedPaths: plan.changedPaths };
      return {
        outcome: "created",
        source,
        releaseKey: plan.releaseKey,
        branch: `release-updates/${plan.releaseKey}`,
        pullRequest: 41,
        preparationFailed: failure !== undefined,
        riskLabels: ["release-update"],
      };
    },
  });

  assert.deepEqual(commands, [
    "install architecture dependencies",
    "prepare pinned upstream source",
    "check the pinned provider table",
    "build the pinned hosted framework",
  ]);
  assert.equal(captured?.failure, "Candidate preparation failed. See the Release updates workflow run for details.");
  assert.equal(captured?.failure?.includes("ghp_"), false);
  assert.equal(captured?.failure?.includes("/Users/runner"), false);
  assert.ok(captured?.changedPaths.includes("scripts/releases/receipts/node.json"));
  assert.equal(result.preparationFailed, true);
  assert.equal(result.reconciliation.pullRequest, 41);
});

test("does not pass credentials into upstream build commands", () => {
  assert.deepEqual(releaseBuildEnvironment({
    PATH: "/usr/bin",
    GITHUB_REPOSITORY: "owner/repository",
    RELEASE_UPDATE_TOKEN: "release-token",
    GH_TOKEN: "github-token",
    PROVIDER_API_KEY: "provider-key",
  }), {
    PATH: "/usr/bin",
    GITHUB_REPOSITORY: "owner/repository",
  });
});

test("does not reconcile or change pins while waiting for a published tools release", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const upstreamBefore = readFileSync(join(root, "upstream.json"), "utf8");
  const releasesBefore = readFileSync(join(root, "containers/pool/releases.json"), "utf8");
  const paths: string[] = [];
  let reconciled = false;
  const api = {
    async get(path: string) {
      paths.push(path);
      if (path === "repos/UsefulSoftwareCo/executor/releases?per_page=100&page=1")
        return [{ tag_name: "executor@1.9.99", draft: false }];
      throw new Error(`Unexpected API request: ${path}`);
    },
    async request() { return undefined; },
    async compare() { return { complete: true, status: "identical" as const, aheadBy: 0, behindBy: 0, files: [] }; },
    async compareTrees() { return { complete: true, status: "diverged" as const, aheadBy: 0, behindBy: 0, files: [] }; },
  } as unknown as ReleaseUpdateApi;

  await assert.rejects(runReleaseUpdate(root, "tools", "release-token", {
    api,
    repository: "owner/repository",
    resetMain: () => sha("1"),
    runCommand: () => assert.fail("preparation must not run without a released candidate"),
    reconcile: async () => {
      reconciled = true;
      throw new Error("unreleased pins must not reach PR reconciliation");
    },
  }), /No published versioned Executor v2 release is available yet/);

  assert.deepEqual(paths, ["repos/UsefulSoftwareCo/executor/releases?per_page=100&page=1"]);
  assert.equal(reconciled, false);
  assert.equal(readFileSync(join(root, "upstream.json"), "utf8"), upstreamBefore);
  assert.equal(readFileSync(join(root, "containers/pool/releases.json"), "utf8"), releasesBefore);
});
