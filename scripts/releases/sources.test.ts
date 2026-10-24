import assert from "node:assert/strict";
import test from "node:test";
import { latestReleasedArtifact, latestToolsCandidate } from "./sources.ts";
import { artifact, digest, releases, sha } from "./fixtures.test-helpers.ts";
import type { GitHubApi } from "./github.ts";

test("selects the newest released v2 tag and verifies the hosted cloud package at that tag", async () => {
  const cloudPackage = Buffer.from(JSON.stringify({ name: "@executor-js/hosted-cloud" })).toString("base64");
  const api = fakeApi({
    "repos/UsefulSoftwareCo/executor/releases?per_page=100&page=1": [
      { tag_name: "executor@2.0.0-beta.9", draft: false },
      { tag_name: "executor@1.9.99", draft: false },
      { tag_name: "executor@2.0.0-beta.27", draft: false },
    ],
    "repos/UsefulSoftwareCo/executor/commits/executor%402.0.0-beta.27": { sha: sha("9") },
    "repos/UsefulSoftwareCo/executor/contents/apps/hosted/cloud/package.json?ref=executor%402.0.0-beta.27": { encoding: "base64", content: cloudPackage },
  });
  const candidate = await latestToolsCandidate(api, "UsefulSoftwareCo/executor");
  assert.equal(candidate.tag, "executor@2.0.0-beta.27");
  assert.equal(candidate.commit, sha("9"));
});

test("waits for a published v2 release without requesting the moving branch", async () => {
  const paths: string[] = [];
  const api = {
    async get(path: string) {
      paths.push(path);
      if (path === "repos/UsefulSoftwareCo/executor/releases?per_page=100&page=1")
        return [
          { tag_name: "executor@2.0.0-beta.99", draft: true },
          { tag_name: "executor@1.9.99", draft: false },
        ];
      throw new Error(`Unexpected API request: ${path}`);
    },
  } as unknown as GitHubApi;
  await assert.rejects(latestToolsCandidate(api, "UsefulSoftwareCo/executor"), /No published versioned Executor v2 release is available yet/);
  assert.deepEqual(paths, ["repos/UsefulSoftwareCo/executor/releases?per_page=100&page=1"]);
});

test("rejects an Executor release tag without the hosted cloud package", async () => {
  const api = fakeApi({
    "repos/UsefulSoftwareCo/executor/releases?per_page=100&page=1": [
      { tag_name: "executor@2.0.0-beta.27", draft: false },
    ],
    "repos/UsefulSoftwareCo/executor/commits/executor%402.0.0-beta.27": { sha: sha("9") },
    "repos/UsefulSoftwareCo/executor/contents/apps/hosted/cloud/package.json?ref=executor%402.0.0-beta.27": {
      encoding: "base64",
      content: Buffer.from(JSON.stringify({ name: "executor" })).toString("base64"),
    },
  });
  await assert.rejects(latestToolsCandidate(api, "UsefulSoftwareCo/executor"), /does not contain the hosted cloud service source/);
});

test("pins only the no-plugin Linux assets and requires their immutable digests", async () => {
  const latest = releases("home", "1.1.7", "a");
  const api = fakeApi({
    "repos/router-for-me/CLIProxyAPIHome/releases/latest": latest,
    "repos/router-for-me/CLIProxyAPIHome/commits/v1.1.7": { sha: sha("d") },
  });
  const current = artifact("home", "v1.1.6", sha("b"), "1");
  const next = await latestReleasedArtifact(api, current.repository, "home", current);
  assert.equal(next.tag, "v1.1.7");
  assert.equal(next.commit, sha("d"));
  assert.equal(next.assets.amd64.name, "CLIProxyAPIHome_1.1.7_linux_amd64_no-plugin.tar.gz");
  assert.equal(next.assets.arm64.name, "CLIProxyAPIHome_1.1.7_linux_aarch64_no-plugin.tar.gz");
  assert.equal(next.assets.amd64.sha256, digest("a"));
});

test("does not accept a Home release without SHA-256 metadata", async () => {
  const latest = releases("home", "1.1.7", "a");
  (latest.assets[0] as { name: string; digest?: string | null }).digest = null;
  const api = fakeApi({ "repos/router-for-me/CLIProxyAPIHome/releases/latest": latest });
  await assert.rejects(latestReleasedArtifact(api, "router-for-me/CLIProxyAPIHome", "home", artifact("home", "v1.1.6", sha("b"), "1")), /Missing immutable SHA-256 digest/);
});

function fakeApi(responses: Record<string, unknown>): GitHubApi {
  return {
    async get(path: string) {
      if (!(path in responses)) throw new Error(`Unexpected API request ${path}`);
      return responses[path];
    },
  } as unknown as GitHubApi;
}
