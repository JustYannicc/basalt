import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brand } from "../../brand.ts";
import { previewPassed, runPreviewAcceptance, runPreviewFromEnvironment } from "./preview.ts";
import type { PreviewConfig } from "./preview-config.ts";

const config: PreviewConfig = {
  origin: "https://stage.example.invalid", email: "test@example.invalid", password: "PRIVATE-PASSWORD",
  organizationId: "private-org", poolAppId: "private-app", claudeLogin: { type: "claude" },
  codexLogin: { type: "codex" }, codexAuthFile: "/private/auth.json", models: { claude: "test-claude", codex: "test-codex" },
};

function fixture(fail = "") {
  const calls: string[] = [];
  const accounts: { id: string }[] = [];
  let computers = 0;
  const payload = { version: 1 as const, brand, instructions: "fixture", credentials: { modelUrl: config.origin, modelKey: "PRIVATE-MODEL-KEY",
    toolsUrl: `${config.origin}/mcp`, toolsToken: "PRIVATE-TOOLS-TOKEN" } };
  async function action(name: string) {
    calls.push(name);
    if (name === fail) throw new Error("PRIVATE-FAILURE-DATA");
  }
  const client = {
    async signIn() { await action("sign-in"); },
    async poolView() { return { isOwner: true as const, accounts: [...accounts] }; },
    async importAccount(file: unknown) {
      const id = `account-${accounts.length}`;
      accounts.push({ id });
      await action("import");
      return id;
    },
    async removeAccount(id: string) { await action(`remove:${id}`); accounts.splice(accounts.findIndex(account => account.id === id), 1); },
    async claimComputer() { const id = `computer-${++computers}`; await action(`claim:${id}`); return { id, payload }; },
    async waitForComputer(id: string) {
      await action(`observe:${id}`);
      const at = fail === "stale" ? "2000-01-01T00:00:00.000Z" : new Date().toISOString();
      return { firstModelRequestAt: at, firstToolCallAt: at, secret: "PRIVATE-EXTRA-FIELD" };
    },
    async revokeComputer(id: string) { await action(`revoke:${id}`); },
    async verifyRevoked() { await action("reject-old-credentials"); },
    async signOut() { await action("sign-out"); },
  };
  const native = async ({ client: name }: { client: "claude" | "codex" }) => {
    await action(`install:${name}`);
    return {
      async run() { await action(`run:${name}`); return { modelReplyMatched: true as const, toolCallObserved: true as const }; },
      async undo() { await action(`undo:${name}`); },
      async dispose() { await action(`dispose:${name}`); },
    };
  };
  return { client, native, calls };
}

test("preview success requires both native clients, fresh server observations and verified cleanup", async () => {
  const f = fixture();
  const result = await runPreviewAcceptance(config, f);
  assert.equal(previewPassed(result), true);
  assert.deepEqual(Object.keys(result).sort(), ["cleanup", "clients", "mode", "pool", "signIn", "version"]);
  for (const client of result.clients) {
    assert.deepEqual(Object.keys(client).sort(), ["client", "exit", "modelRequest", "revoke", "timeout", "toolSearch", "undo"]);
  }
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(result).includes(config.origin), false);
  assert.ok(f.calls.includes("run:claude") && f.calls.includes("run:codex"));
  assert.deepEqual(f.calls.slice(-3), ["remove:account-1", "remove:account-0", "sign-out"]);
  const missing = structuredClone(result);
  missing.clients[1]!.toolSearch = false;
  assert.equal(previewPassed(missing), false);
  missing.clients.pop();
  assert.equal(previewPassed(missing), false);
});

test("failed native run still undoes and revokes every claimed computer and removes imported accounts", async () => {
  const f = fixture("run:codex");
  const result = await runPreviewAcceptance(config, f);
  assert.equal(previewPassed(result), false);
  assert.equal(result.cleanup, true);
  assert.equal(result.clients[1]!.exit, null);
  assert.equal(result.clients[1]!.modelRequest, false);
  for (const operation of ["undo:claude", "undo:codex", "dispose:claude", "dispose:codex", "revoke:computer-1", "revoke:computer-2",
    "remove:account-0", "remove:account-1", "sign-out"]) assert.ok(f.calls.includes(operation), operation);
});

test("cleanup failures and stale server timestamps cannot produce a passing receipt", async () => {
  for (const failure of ["undo:codex", "dispose:claude", "revoke:computer-1", "reject-old-credentials", "remove:account-0", "sign-out", "stale"]) {
    const f = fixture(failure);
    const result = await runPreviewAcceptance(config, f);
    assert.equal(previewPassed(result), false, failure);
    if (failure !== "stale") assert.equal(result.cleanup, false, failure);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    assert.ok(f.calls.includes("sign-out"), failure);
  }
});

test("ambiguous resource creation reports cleanup unverified and still revokes known resources", async () => {
  for (const failure of ["import", "install:claude"]) {
    const f = fixture(failure);
    const result = await runPreviewAcceptance(config, f);
    assert.equal(previewPassed(result), false);
    assert.equal(result.cleanup, false);
    if (failure === "install:claude") assert.ok(f.calls.includes("revoke:computer-1"));
    assert.ok(f.calls.includes("sign-out"));
  }
});

test("an existing pool account stops preview before any import or native launch", async () => {
  const f = fixture();
  f.client.poolView = async () => ({ isOwner: true as const, accounts: [{ id: "existing-private-account" }] });
  const result = await runPreviewAcceptance(config, f);
  assert.equal(previewPassed(result), false);
  assert.equal(result.pool, false);
  assert.deepEqual(f.calls, ["sign-in", "sign-out"]);
});

test("duplicate account rows cannot stand in for the second imported subscription", async () => {
  const f = fixture();
  let views = 0;
  f.client.poolView = async () => ({ isOwner: true as const, accounts: ++views === 1 ? [] : [
    { id: "account-0" }, { id: "account-0" },
  ] });
  const result = await runPreviewAcceptance(config, f);
  assert.equal(result.pool, false);
  assert.equal(previewPassed(result), false);
  assert.equal(f.calls.some(call => call.startsWith("install:")), false);
});

test("configuration failure writes only the frozen failure schema in a fresh private report", async t => {
  const directory = await mkdtemp(join(tmpdir(), "preview-result-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "result.json");
  assert.equal(await runPreviewFromEnvironment({ POOL_ACCEPTANCE_RESULT_PATH: path }), false);
  const result = JSON.parse(await readFile(path, "utf8"));
  assert.equal(previewPassed(result), false);
  assert.equal(result.clients.length, 2);
  assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal(await runPreviewFromEnvironment({ POOL_ACCEPTANCE_RESULT_PATH: path }), false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), result);
});

test("the actual preview entry point writes a failed receipt instead of requiring the full-mode key", async t => {
  const directory = await mkdtemp(join(tmpdir(), "preview-entrypoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "result.json");
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../pool-acceptance.ts", import.meta.url))], {
    env: { POOL_ACCEPTANCE_MODE: "preview", POOL_ACCEPTANCE_RESULT_PATH: path }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(run.status, 1);
  assert.equal(run.stdout.trim(), "acceptance status=failed mode=preview");
  assert.equal(run.stderr, "");
  assert.equal(previewPassed(JSON.parse(await readFile(path, "utf8"))), false);
});
