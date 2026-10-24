import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { applyUpdatePlan, planUpdate } from "./update.ts";
import { makeReleaseRoot, oauthSource, releases, sha } from "./fixtures.test-helpers.ts";
import type { GitHubApi } from "./github.ts";
import { readPatchManifest } from "./patches.ts";
import { sha256PatchContent } from "./patch-registry.ts";

test("Home and node releases create separate, idempotent pin updates", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const api = fakeApi();

  const homePlan = await planUpdate(root, "home", api);
  assert.equal(homePlan.releaseKey, "home-v1.1.7");
  assert.equal(homePlan.candidatePins.home.tag, "v1.1.7");
  assert.equal(homePlan.candidatePins.node.tag, "v8.0.40");
  assert.deepEqual(homePlan.changedPaths.sort(), [
    "containers/pool/releases.json",
    "scripts/releases/receipts/home.json",
    "src/pool/providers.json",
  ]);
  applyUpdatePlan(root, homePlan);

  const homeRepeat = await planUpdate(root, "home", api);
  assert.deepEqual(homeRepeat.changedPaths, []);

  const nodePlan = await planUpdate(root, "node", api);
  assert.equal(nodePlan.releaseKey, "node-v8.0.41");
  assert.equal(nodePlan.candidatePins.home.tag, "v1.1.7");
  assert.equal(nodePlan.candidatePins.node.tag, "v8.0.41");
  assert.deepEqual(nodePlan.changedPaths.sort(), [
    "containers/pool/releases.json",
    "scripts/releases/receipts/node.json",
  ]);
  applyUpdatePlan(root, nodePlan);
  assert.deepEqual((await planUpdate(root, "node", api)).changedPaths, []);
});

test("tools v2 release updates are idempotent and remove only proven merged patches", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const api = fakeApi({
    pulls: { 10: { merged: true, merge_commit_sha: sha("f") } },
    ancestor: true,
  });

  const plan = await planUpdate(root, "tools", api);
  assert.equal(plan.releaseKey, "tools-executor-2.0.0-beta.27-eeeeeeeeeeee");
  assert.equal(plan.candidatePins.tools.commit, sha("e"));
  assert.deepEqual(plan.patchDecisions.find((decision) => decision.identity === "executor-review"), {
    identity: "executor-review",
    file: "0001-review.patch",
    content_sha256: readPatchManifest(root).patches.find(({ identity }) => identity === "executor-review")?.content_sha256,
    remove: true,
    reason: "merged-commit-in-candidate",
  });
  assert.ok(plan.files.some((file) => file.path === "patches/0001-review.patch" && file.content === null));
  assert.equal(plan.files.some((file) => file.path === "patches/0004-workflow.patch"), false);
  assert.deepEqual(plan.changedPaths.sort(), [
    "patches/0001-review.patch",
    "scripts/releases/patches.json",
    "scripts/releases/receipts/tools.json",
    "upstream.json",
  ]);
  applyUpdatePlan(root, plan);
  assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(join(root, "patches/0001-review.patch"))), false);
  assert.deepEqual((await planUpdate(root, "tools", api)).changedPaths, []);
});

test("keeps a merged patch when its merge commit is not in the candidate", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const api = fakeApi({
    pulls: { 10: { merged: true, merge_commit_sha: sha("f") } },
    ancestor: false,
  });
  const plan = await planUpdate(root, "tools", api);
  assert.deepEqual(plan.patchDecisions.find((decision) => decision.identity === "executor-review"), {
    identity: "executor-review",
    file: "0001-review.patch",
    content_sha256: readPatchManifest(root).patches.find(({ identity }) => identity === "executor-review")?.content_sha256,
    remove: false,
    reason: "merge-commit-not-in-candidate",
  });
  assert.equal(plan.files.some((file) => file.path === "patches/0001-review.patch"), false);
});

test("an invalid patch does not prevent the tools candidate plan", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const patch = `diff --git a/source.txt b/source.txt
--- a/source.txt
+++ b/source.txt
@@ -1 +1 @@
-missing upstream text
+replacement
`;
  writeFileSync(join(root, "patches/0001-review.patch"), patch);
  writeFileSync(join(root, "source.txt"), "the source changed\n");
  const manifestPath = join(root, "scripts/releases/patches.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    patches: Array<{ identity: string; content_sha256: string }>;
  };
  manifest.patches.find(({ identity }) => identity === "executor-review")!.content_sha256 = sha256PatchContent(patch);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const failure = spawnApplyCheck(root);
  assert.notEqual(failure, 0);

  const plan = await planUpdate(root, "tools", fakeApi());
  assert.equal(plan.candidatePins.tools.commit, sha("e"));
  assert.ok(plan.changedPaths.includes("upstream.json"));
  assert.equal(plan.files.some((file) => file.path === "scripts/releases/patches.json"), false);
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).patches[0].content_sha256, sha256PatchContent(patch));
});

test("release receipts are stable and contain the source-specific base and candidate pins", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = await planUpdate(root, "node", fakeApi());
  const receipt = plan.files.find((file) => file.path === "scripts/releases/receipts/node.json")?.content;
  assert.ok(receipt);
  const value = JSON.parse(receipt);
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.source, "node");
  assert.equal(value.releaseKey, "node-v8.0.41");
  assert.equal(value.basePins.node.tag, "v8.0.40");
  assert.equal(value.candidatePins.node.tag, "v8.0.41");
  assert.equal(value.candidatePins.home.tag, "v1.1.6");
  assert.deepEqual(value.removedPatches, []);
  assert.deepEqual(Object.keys(value).sort(), ["basePins", "candidatePins", "releaseKey", "removedPatches", "schemaVersion", "source"]);
});

test("provider source generation failure leaves an update candidate and writes no error text to the receipt", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = await planUpdate(root, "home", fakeApi({ providerFailure: true }));
  assert.equal(plan.providerTableGenerationFailed, true);
  assert.ok(plan.changedPaths.includes("containers/pool/releases.json"));
  assert.ok(plan.changedPaths.includes("scripts/releases/receipts/home.json"));
  assert.equal(plan.changedPaths.includes("src/pool/providers.json"), false);
  const receipt = plan.files.find((file) => file.path === "scripts/releases/receipts/home.json")?.content;
  assert.ok(receipt);
  assert.equal(receipt.includes("providerTable"), false);
  assert.equal(receipt.includes("private path"), false);
});

test("requires an exact patch-manifest match with every carried patch file", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "patches/0011-preview-auth.patch"), "untracked patch\n");
  assert.throws(() => readPatchManifest(root), /does not match the patches directory/);
});

test("stale content hashes reject a reused filename before release API calls", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "patches/0001-review.patch"), "different patch content under the old filename\n");
  let apiCalls = 0;
  const api = {
    async get() {
      apiCalls++;
      throw new Error("release API must not be called");
    },
    async compare() {
      apiCalls++;
      throw new Error("release API must not be called");
    },
  } as unknown as GitHubApi;
  await assert.rejects(planUpdate(root, "tools", api), /digest does not match registry identity/);
  assert.equal(apiCalls, 0);
});

function spawnApplyCheck(root: string): number {
  try {
    execFileSync("git", ["apply", "--check", "patches/0001-review.patch"], { cwd: root, stdio: "ignore" });
    return 0;
  } catch (error) {
    return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 1;
  }
}

function fakeApi(options: { pulls?: Record<number, unknown>; ancestor?: boolean; providerFailure?: boolean } = {}): GitHubApi {
  const pullDetails = options.pulls ?? {};
  return {
    async get(path: string) {
      if (path === "repos/UsefulSoftwareCo/executor/releases?per_page=100&page=1")
        return [{ tag_name: "executor@2.0.0-beta.27", draft: false }];
      if (path === "repos/UsefulSoftwareCo/executor/commits/executor%402.0.0-beta.27") return { sha: sha("e") };
      if (path === "repos/UsefulSoftwareCo/executor/contents/apps/hosted/cloud/package.json?ref=executor%402.0.0-beta.27")
        return { encoding: "base64", content: Buffer.from(JSON.stringify({ name: "@executor-js/hosted-cloud" })).toString("base64") };
      if (path === "repos/router-for-me/CLIProxyAPIHome/releases/latest") return releases("home", "1.1.7", "3");
      if (path === "repos/router-for-me/CLIProxyAPI/releases/latest") return releases("node", "8.0.41", "4");
      if (path === "repos/router-for-me/CLIProxyAPIHome/commits/v1.1.7") return { sha: sha("d") };
      if (path === "repos/router-for-me/CLIProxyAPI/commits/v8.0.41") return { sha: sha("e") };
      if (path === `repos/router-for-me/CLIProxyAPIHome/contents/internal/cluster/management/oauth_v8.go?ref=${sha("d")}` && options.providerFailure)
        throw new Error("private path /tmp/example could not be read");
      if (path === `repos/router-for-me/CLIProxyAPIHome/contents/internal/cluster/management/oauth_v8.go?ref=${sha("d")}`)
        return { encoding: "base64", content: Buffer.from(oauthSource).toString("base64") };
      const pull = /\/pulls\/(\d+)$/.exec(path);
      if (pull) return pullDetails[Number(pull[1])] ?? { merged: false, merge_commit_sha: null };
      throw new Error(`Unexpected API request: ${path}`);
    },
    async compare() {
      return { complete: true, status: options.ancestor === false ? "diverged" : "ahead", aheadBy: 1, behindBy: 0, files: [] };
    },
  } as unknown as GitHubApi;
}

test("fixture provider update reads the candidate source at its exact commit", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = await planUpdate(root, "home", fakeApi());
  const providers = plan.files.find((file) => file.path === "src/pool/providers.json")?.content;
  assert.equal(providers, '[\n  {\n    "id": "claude",\n    "name": "Claude"\n  },\n  {\n    "id": "codex",\n    "name": "Codex"\n  },\n  {\n    "id": "gemini",\n    "name": "Gemini"\n  }\n]\n');
});

test("pool update plan preserves unrelated provider data and artifact pins", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const originalNode = JSON.parse(readFileSync(join(root, "containers/pool/releases.json"), "utf8")).artifacts.node;
  const plan = await planUpdate(root, "home", fakeApi());
  const releasesFile = plan.files.find((file) => file.path === "containers/pool/releases.json")?.content;
  assert.ok(releasesFile);
  assert.deepEqual(JSON.parse(releasesFile).artifacts.node, originalNode);
});

