import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubApi } from "./github.ts";
import { RELEASE_MERGE_POLICY } from "./policy.ts";

test("artifact redirects do not forward the GitHub token", async () => {
  const requests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init.headers).get("authorization"), redirect: init.redirect });
    if (url.includes("/actions/runs/20/artifacts")) {
      return Response.json({ artifacts: [{ id: 7, name: RELEASE_MERGE_POLICY.previewArtifactName(19, "b".repeat(40)), expired: false }] });
    }
    if (url.endsWith("/actions/artifacts/7/zip")) {
      return new Response(null, { status: 302, headers: { location: "https://storage.example.test/download?sig=fixture" } });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  const api = new GitHubApi("sensitive-fixture-token", fetchImpl);

  await assert.rejects(api.getPreviewReceipt("owner/repo", 20, RELEASE_MERGE_POLICY.previewArtifactName(19, "b".repeat(40))), /Preview receipt artifact is invalid/);
  assert.equal(requests.length, 3);
  assert.equal(requests[0]!.authorization, "Bearer sensitive-fixture-token");
  assert.equal(requests[1]!.authorization, "Bearer sensitive-fixture-token");
  assert.equal(requests[1]!.redirect, "manual");
  assert.equal(requests[2]!.authorization, null);
  assert.equal(requests[2]!.redirect, "manual");
});

test("branch refresh sends GitHub the expected head guard", async () => {
  const requests: Array<{ url: string; method: string | undefined; authorization: string | null; body: string | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    requests.push({
      url: String(input),
      method: init.method,
      authorization: new Headers(init.headers).get("authorization"),
      body: typeof init.body === "string" ? init.body : undefined,
    });
    return new Response(null, { status: 202 });
  };
  const api = new GitHubApi("fixture-token", fetchImpl);

  assert.equal(await api.updatePullRequestBranch("owner/repo", 19, "b".repeat(40)), "accepted");
  assert.deepEqual(requests, [{
    url: "https://api.github.com/repos/owner/repo/pulls/19/update-branch",
    method: "POST",
    authorization: "Bearer fixture-token",
    body: JSON.stringify({ expected_head_sha: "b".repeat(40) }),
  }]);
});

test("branch refresh reports an expected-head conflict without treating it as accepted", async () => {
  const api = new GitHubApi("fixture-token", async () => new Response(null, { status: 422 }));
  assert.equal(await api.updatePullRequestBranch("owner/repo", 19, "b".repeat(40)), "rejected");
});
