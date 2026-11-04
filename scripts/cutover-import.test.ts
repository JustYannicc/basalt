import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importAccounts, ImportFailure, type ImportConfig } from "./cutover/import.ts";
import { loadImportConfig } from "./cutover/files.ts";

const config: ImportConfig = {
  origin: "https://pool.example.invalid",
  poolToken: "private-pool-token",
  owner: "fixture-owner",
  apiKey: "private-computer-key",
  organization: "org_fixture",
  poolApp: "app_pool",
  cookie: "fixture-cookie",
  accounts: [
    {
      providerApp: "app_provider",
      creation: "00000000-0000-4000-8000-000000000001",
      file: { type: "codex", access_token: "private-login-token" },
      model: "fixture-model",
    },
  ],
  attempts: 2,
};
function stream(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  });
}
function fixture(
  options: { owner?: boolean; wrong?: boolean; error?: boolean; late?: boolean } = {},
) {
  const calls: string[] = [];
  let polls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    if (options.error) throw new Error("private-login-token private-pool-token");
    if (url.pathname === "/pool/v1/pool")
      return Response.json({ isOwner: options.owner ?? true, accounts: [] });
    if (url.pathname.endsWith("/import-login-file")) {
      assert.equal(new Headers(init?.headers).get("cookie"), "fixture-cookie");
      assert.equal(JSON.parse(String(init?.body)).file.access_token, "private-login-token");
      return Response.json({ id: "acc_imported" });
    }
    if (init?.method === "PUT") return Response.json(null);
    if (url.pathname === "/v1/chat/completions") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-computer-key");
      assert.ok(new Headers(init?.headers).get("X-Session-ID"));
      return stream();
    }
    if (url.pathname.endsWith("/pool-usage/last-success")) {
      const input = JSON.parse(String(init?.body));
      assert.deepEqual(input.accounts, ["acc_imported"]);
      assert.ok(input.session);
      return Response.json({
        mapping: { proof: "proven" },
        accounts:
          options.late && polls++ === 0
            ? []
            : [
                {
                  account: options.wrong ? "acc_other" : "acc_imported",
                  lastSuccessAt: new Date(Date.now() + 1).toISOString(),
                },
              ],
      });
    }
    throw new Error("Unexpected fixture request");
  };
  return { calls, fetch: fetcher, delay: async () => {} };
}

test("imports through owner upload and requires exact account usage after a generated stream", async () => {
  const deps = fixture({ late: true });
  assert.deepEqual(await importAccounts(config, deps), { verified: 1 });
  assert.deepEqual(deps.calls, [
    "/pool/v1/pool",
    "/api/organizations/org_fixture/apps/app_provider/accounts/app/openai/import-login-file",
    "/api/organizations/org_fixture/apps/app_pool/accounts/app/openai/acc_imported",
    "/v1/chat/completions",
    "/api/organizations/org_fixture/apps/app_pool/pool-usage/last-success",
    "/api/organizations/org_fixture/apps/app_pool/pool-usage/last-success",
  ]);
});
test("membership alone and a successful stream from another account never pass", async () => {
  const deps = fixture({ wrong: true });
  await assert.rejects(
    importAccounts(config, deps),
    (error: unknown) => error instanceof ImportFailure && error.stage === "verification",
  );
  assert.equal(deps.calls.filter((path) => path === "/v1/chat/completions").length, 2);
});
test("non-owner never uploads and malformed later files fail before any network request", async () => {
  const deps = fixture({ owner: false });
  await assert.rejects(importAccounts(config, deps), /owner/);
  assert.deepEqual(deps.calls, ["/pool/v1/pool"]);
  deps.calls.length = 0;
  await assert.rejects(
    importAccounts(
      {
        ...config,
        accounts: [...config.accounts, { ...config.accounts[0]!, file: {}, model: "model" }],
      },
      deps,
    ),
    /inputs/,
  );
  assert.deepEqual(deps.calls, []);
});
test("errors contain no raw upstream credentials and insecure origins fail before requests", async () => {
  await assert.rejects(importAccounts(config, fixture({ error: true })), (error: unknown) => {
    assert.ok(error instanceof ImportFailure);
    assert.doesNotMatch(error.message, /private-/);
    assert.equal(error.cause, undefined);
    return true;
  });
  for (const origin of [
    "http://remote.example.invalid",
    "https://user:password@example.invalid",
    "https://example.invalid/subpath",
  ]) {
    const deps = fixture();
    await assert.rejects(importAccounts({ ...config, origin }, deps), /inputs/);
    assert.deepEqual(deps.calls, []);
  }
});
test("private file input rejects exposed permissions, symlinks and invalid JSON without leaking paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "basalt-import-test-"));
  const login = join(dir, "login.json");
  const manifest = join(dir, "import.json");
  try {
    await writeFile(login, JSON.stringify(config.accounts[0]!.file), { mode: 0o600 });
    await writeFile(
      manifest,
      JSON.stringify({
        ...config,
        accounts: [
          {
            path: "login.json",
            model: "fixture-model",
            providerApp: config.accounts[0]!.providerApp,
            creation: config.accounts[0]!.creation,
          },
        ],
      }),
      { mode: 0o600 },
    );
    assert.deepEqual(await loadImportConfig(manifest), config);
    await chmod(login, 0o644);
    await assert.rejects(loadImportConfig(manifest), (error: unknown) => {
      assert.ok(error instanceof ImportFailure);
      assert.doesNotMatch(error.message, /login\.json|basalt-import-test/);
      return true;
    });
    await chmod(login, 0o600);
    await symlink(manifest, join(dir, "link.json"));
    await assert.rejects(loadImportConfig(join(dir, "link.json")), /inputs/);
    await writeFile(login, "private-invalid-json");
    await assert.rejects(loadImportConfig(manifest), /inputs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
