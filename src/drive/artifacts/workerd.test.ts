// Real workerd (Miniflare) with SQLite Durable Object storage and R2. The Artifacts control plane
// is a stand-in for the binding's documented methods; the Git data plane is real `git http-backend`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { backend, git, token } from "./test/backend.ts";

test("the vault object lands checkpoints from inside a Durable Object", async (t) => {
  const server = await backend();
  t.after(() => server.close());
  const bundle = await build({
    // Untyped like the other Worker fixtures; root types have no Workers globals.
    stdin: {
      contents: await readFile(
        new URL("./test/vault-worker.fixture.ts.txt", import.meta.url),
        "utf8",
      ),
      resolveDir: fileURLToPath(new URL("./test/", import.meta.url)),
      sourcefile: "vault-worker.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:workers"],
    write: false,
    logLevel: "silent",
  });
  const runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { VAULT: { className: "Vault", useSQLite: true } },
    r2Buckets: ["ATTACHMENTS"],
  });
  t.after(() => runtime.dispose());
  const call = async (command: unknown) => {
    const response = await runtime.dispatchFetch("http://vault.test", {
      method: "POST",
      body: JSON.stringify({ url: server.url, token, command }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as {
      ok: boolean;
      value?: { oid: string; state: string };
      error?: unknown;
    };
  };
  const listed = await call({ operation: "drive", method: "list", input: {} });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const root = git(server.bare, "rev-parse", "main").toString().trim();
  const first = await call({
    operation: "drive",
    method: "apply",
    input: {
      base: root,
      operation: "first",
      edits: [{ path: "daily/today.md", content: "from workerd" }],
    },
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value?.state, "landed");
  // A stale base lands as a merge pushed against the current main.
  const second = await call({
    operation: "drive",
    method: "apply",
    input: { base: root, operation: "second", edits: [{ path: "other.md", content: "parallel" }] },
  });
  assert.equal(second.value?.state, "landed");
  assert.equal(git(server.bare, "rev-parse", "main").toString().trim(), second.value?.oid);
  assert.equal(git(server.bare, "show", "main:daily/today.md").toString(), "from workerd");
  assert.equal(git(server.bare, "show", "main:other.md").toString(), "parallel");
  // Workerd's SQLite refuses rows near 2 MB; a 3 MiB note must still land.
  const large = await call({
    operation: "drive",
    method: "apply",
    input: {
      base: second.value!.oid,
      operation: "large",
      edits: [{ path: "large.md", content: "x".repeat(3 * 1024 * 1024) }],
    },
  });
  assert.equal(large.value?.state, "landed", JSON.stringify(large));
  assert.equal(
    Number(git(server.bare, "cat-file", "-s", "main:large.md").toString()),
    3 * 1024 * 1024,
  );
  git(server.bare, "fsck", "--full", "--strict");
});
