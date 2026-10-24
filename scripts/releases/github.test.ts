import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApi } from "./github.ts";

test("treats a short complete GitHub compare file page as complete without changed_files", async () => {
  const files = Array.from({ length: 13 }, (_, index) => ({ filename: `apps/hosted/cloud/src/file-${index}.ts` }));
  const api = new GitHubApi(undefined, async () => new Response(JSON.stringify({ status: "ahead", ahead_by: 2, files }), { status: 200 }));
  const comparison = await api.compare("UsefulSoftwareCo/executor", "a", "b");
  assert.equal(comparison.complete, true);
  assert.equal(comparison.files.length, 13);
});

test("reads the next compare file page before declaring completeness", async () => {
  const calls: string[] = [];
  const api = new GitHubApi(undefined, async (input) => {
    const url = String(input);
    calls.push(url);
    const page = new URL(url).searchParams.get("page");
    const files = Array.from({ length: page === "1" ? 100 : 17 }, (_, index) => ({ filename: `file-${page}-${index}.ts` }));
    return new Response(JSON.stringify({ status: "ahead", ahead_by: 2, files }), { status: 200 });
  });
  const comparison = await api.compare("UsefulSoftwareCo/executor", "a", "b");
  assert.equal(comparison.complete, true);
  assert.equal(comparison.files.length, 117);
  assert.equal(calls.length, 2);
});

test("caps source proof at GitHub's 300-file compare window", async () => {
  const api = new GitHubApi(undefined, async (input) => {
    const page = new URL(String(input)).searchParams.get("page");
    const files = Array.from({ length: page === "3" ? 100 : 100 }, (_, index) => ({ filename: `page-${page}-${index}.ts` }));
    return new Response(JSON.stringify({ status: "ahead", ahead_by: 2, files }), { status: 200 });
  });
  const comparison = await api.compare("UsefulSoftwareCo/executor", "a", "b");
  assert.equal(comparison.complete, false);
  assert.equal(comparison.files.length, 300);
});

test("compares immutable source trees without requiring a shared commit ancestor", async () => {
  const api = new GitHubApi(undefined, async (input) => {
    const url = String(input);
    const base = url.endsWith("base?recursive=1");
    const tree = base
      ? [
          { path: "README.md", mode: "100644", sha: "readme", type: "blob" },
          { path: "apps/hosted/cloud/src/main.ts", mode: "100644", sha: "old-runtime", type: "blob" },
          { path: "apps/hosted/cloud/public/brand.svg", mode: "100644", sha: "same-asset", type: "blob" },
        ]
      : [
          { path: "README.md", mode: "100644", sha: "readme", type: "blob" },
          { path: "apps/hosted/cloud/src/main.ts", mode: "100644", sha: "new-runtime", type: "blob" },
          { path: "apps/hosted/cloud/public/brand.svg", mode: "100644", sha: "same-asset", type: "blob" },
          { path: "apps/hosted/cloud/src/new.ts", mode: "100644", sha: "new-file", type: "blob" },
        ];
    return new Response(JSON.stringify({ truncated: false, tree }), { status: 200 });
  });
  const comparison = await api.compareTrees("UsefulSoftwareCo/executor", "base", "candidate");
  assert.equal(comparison.complete, true);
  assert.equal(comparison.status, "diverged");
  assert.deepEqual(comparison.files.map((file) => file.filename), [
    "apps/hosted/cloud/src/main.ts",
    "apps/hosted/cloud/src/new.ts",
  ]);
});

test("rejects a truncated source tree as incomplete evidence", async () => {
  const api = new GitHubApi(undefined, async () => new Response(JSON.stringify({ truncated: true, tree: [] }), { status: 200 }));
  const comparison = await api.compareTrees("UsefulSoftwareCo/executor", "base", "candidate");
  assert.equal(comparison.complete, false);
});

test("compares executable mode changes even when blob content is shared", async () => {
  const api = new GitHubApi(undefined, async (input) => {
    const base = String(input).endsWith("base?recursive=1");
    return new Response(JSON.stringify({
      truncated: false,
      tree: [{ path: "apps/hosted/cloud/src/run.ts", mode: base ? "100644" : "100755", sha: "same", type: "blob" }],
    }), { status: 200 });
  });
  const comparison = await api.compareTrees("UsefulSoftwareCo/executor", "base", "candidate");
  assert.equal(comparison.complete, true);
  assert.deepEqual(comparison.files.map((file) => file.filename), ["apps/hosted/cloud/src/run.ts"]);
});

test("rejects absolute and network-path targets before sending the bearer token", async () => {
  let calls = 0;
  const api = new GitHubApi("release-token", async () => {
    calls++;
    return new Response("{}", { status: 200 });
  });

  await assert.rejects(api.get("https://attacker.example/collect"), /must be relative/);
  await assert.rejects(api.request("POST", "//attacker.example/collect", { value: true }), /must be relative/);
  assert.equal(calls, 0);
});

test("keeps relative requests on the fixed API origin and blocks redirects", async () => {
  const api = new GitHubApi("release-token", async (input, init) => {
    assert.equal(new URL(String(input)).origin, "https://api.github.com");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer release-token");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  assert.deepEqual(await api.get<{ ok: boolean }>("repos/owner/repository"), { ok: true });
});
