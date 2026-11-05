import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { preparePreviewAccounts } from "./preview-accounts.ts";
import { PreviewClient } from "./preview-client.ts";
import type { PreviewSetupConfig } from "./preview-config.ts";

const config: PreviewSetupConfig = {
  origin: "https://stage.example.invalid",
  organizationId: "org_stage",
  poolAppId: "app_pool",
  email: "smoke@example.invalid",
  password: "synthetic-private-password",
  codexAuthFile: "unused",
  claudeLogin: { type: "claude", refresh_token: "synthetic-private-claude" },
  codexLogin: { type: "codex", refresh_token: "synthetic-private-codex" },
  models: { claude: "fixture", codex: "fixture" },
};

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "preview-accounts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const imports = new Map<string, string>();
  let loseReply = false;
  const client = new PreviewClient(config, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, config.origin);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === "/api/auth/sign-in/email")
        return Response.json(
          { user: { id: "user_fixture" } },
          { headers: { "set-cookie": "session=synthetic" } },
        );
      if (url.pathname === "/api/auth/sign-out") return Response.json({ success: true });
      if (url.pathname === "/api/auth/get-session") return Response.json(null);
      assert.equal(new Headers(init?.headers).get("cookie"), "session=synthetic");
      assert.equal(new Headers(init?.headers).get("origin"), config.origin);
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      assert.ok(
        !url.pathname.includes("/apps/app_pool/"),
        "setup never links or imports into the pool",
      );
      if (url.pathname.endsWith("/apps/install")) {
        assert.equal(method, "POST");
        return Response.json({
          id: body.entry === "provider-openai" ? "app_openai" : "app_anthropic",
        });
      }
      if (url.pathname.endsWith("/import-login-file")) {
        assert.equal(method, "POST");
        const lab = body.method === "codex" ? "openai" : "anthropic";
        assert.equal(
          url.pathname,
          `/api/organizations/org_stage/apps/app_${lab}/accounts/app/${lab}/import-login-file`,
        );
        assert.deepEqual(body.file, lab === "openai" ? config.codexLogin : config.claudeLogin);
        assert.match(String(body.creation), /^[0-9a-f-]{36}$/);
        const key = String(body.creation);
        if (!imports.has(key)) imports.set(key, `acc_${lab}`);
        if (loseReply) {
          loseReply = false;
          throw new Error("synthetic-private-lost-response");
        }
        return Response.json({ id: imports.get(key) });
      }
      assert.equal(method, "PUT");
      assert.match(url.pathname, /\/apps\/app_(openai|anthropic)\/accounts\/app\/\1\/acc_\1$/);
      return Response.json(null);
    },
  });
  return {
    path: join(directory, "accounts.json"),
    calls,
    imports,
    client,
    loseReply: () => {
      loseReply = true;
    },
  };
}

test("stage setup imports only into provider apps and writes private saved IDs without credentials", async (t) => {
  const f = await fixture(t);
  await preparePreviewAccounts(config, f.path, f.client);
  const raw = await readFile(f.path, "utf8");
  const saved = JSON.parse(raw);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal(raw.includes("synthetic-private"), false);
  assert.deepEqual(saved.accounts, [
    { id: "acc_openai", requirement: "openai" },
    { id: "acc_anthropic", requirement: "anthropic" },
  ]);
  assert.equal(f.imports.size, 2);
  await preparePreviewAccounts(config, f.path, f.client);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/apps/install")).length, 2);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/import-login-file")).length, 2);
  assert.equal(
    f.calls.some((call) => call.method === "DELETE"),
    false,
  );
});

test("an uncertain provider import reuses the persisted creation UUID without duplicating the account", async (t) => {
  const f = await fixture(t);
  f.loseReply();
  await assert.rejects(
    preparePreviewAccounts(config, f.path, f.client),
    /did not return an HTTP response/,
  );
  const first = f.calls.find((call) => call.path.endsWith("/import-login-file"))!;
  await preparePreviewAccounts(config, f.path, f.client);
  const attempts = f.calls.filter((call) => call.path.includes("/openai/import-login-file"));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]!.body.creation, first.body.creation);
  assert.equal(f.imports.size, 2);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/apps/install")).length, 2);
});

test("a saved setup journal from another stage is refused before sign-in or mutation", async (t) => {
  const f = await fixture(t);
  await preparePreviewAccounts(config, f.path, f.client);
  const count = f.calls.length;
  await assert.rejects(
    preparePreviewAccounts({ ...config, organizationId: "org_foreign" }, f.path, f.client),
    /does not match/,
  );
  assert.equal(f.calls.length, count);
});
