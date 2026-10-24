import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewConfigFromEnvironment } from "./preview-config.ts";
import { brand } from "../../brand.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "preview-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    POOL_ACCEPTANCE_ORIGIN: "https://app.pr-17.preview.example.invalid", PREVIEW_SMOKE_EMAIL: "smoke@example.invalid",
    PREVIEW_SMOKE_PULL_REQUEST: "17", ALCHEMY_STAGE: "test-pr-17", TEST_STAGE_DOMAIN: "preview.example.invalid",
    PREVIEW_SMOKE_PASSWORD: "private-password", PREVIEW_SMOKE_ORGANIZATION_ID: "test-org", PREVIEW_SMOKE_POOL_APP_ID: "test-app",
    PREVIEW_CLAUDE_AUTH_FILE: join(root, "claude.json"), PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE: join(root, "subscription.json"),
    PREVIEW_CODEX_CLI_AUTH_FILE: join(root, "cli.json"), PREVIEW_CLAUDE_MODEL: "claude-test", PREVIEW_CODEX_MODEL: "codex-test",
  };
  for (const [file, value] of [[env.PREVIEW_CLAUDE_AUTH_FILE, { type: "claude" }],
    [env.PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE, { type: "codex" }],
    [env.PREVIEW_CODEX_CLI_AUTH_FILE, { auth_mode: "chatgpt", tokens: {
      id_token: "fixture-only", access_token: "fixture-only", refresh_token: "fixture-only" } }]] as const) {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  }
  return { root, env };
}

test("preview configuration requires explicit isolated HTTPS and dedicated auth file types", async t => {
  const { env } = await fixture(t);
  assert.equal((await previewConfigFromEnvironment(env)).origin, env.POOL_ACCEPTANCE_ORIGIN);
  for (const origin of [`https://${brand.host}`, "http://stage.example.invalid", "https://stage.example.invalid/path",
    "https://stage.example.invalid/?secret=value", "https://person:password@stage.example.invalid"]) {
    await assert.rejects(previewConfigFromEnvironment({ ...env, POOL_ACCEPTANCE_ORIGIN: origin }), /separate HTTPS/);
  }
  await writeFile(env.PREVIEW_CLAUDE_AUTH_FILE, JSON.stringify({ type: "codex" }));
  await assert.rejects(previewConfigFromEnvironment(env), /identify Claude and Codex/);
});

test("preview config refuses public or symlinked secrets and does not quote secret input", async t => {
  const { root, env } = await fixture(t);
  await chmod(env.PREVIEW_CODEX_CLI_AUTH_FILE, 0o644);
  await assert.rejects(previewConfigFromEnvironment(env), /^Error: Preview auth files must be private regular JSON files$/);
  await chmod(env.PREVIEW_CODEX_CLI_AUTH_FILE, 0o600);
  const link = join(root, "auth-link");
  await symlink(env.PREVIEW_CODEX_CLI_AUTH_FILE, link);
  await assert.rejects(previewConfigFromEnvironment({ ...env, PREVIEW_CODEX_CLI_AUTH_FILE: link }), /private regular JSON/);
  await writeFile(env.PREVIEW_CODEX_CLI_AUTH_FILE, '{"secret":"DO-NOT-PRINT"');
  await assert.rejects(previewConfigFromEnvironment(env), error => String(error).includes("private regular JSON")
    && !String(error).includes("DO-NOT-PRINT"));
});

test("preview config requires genuine-structure ChatGPT login rather than an API key", async t => {
  const { env } = await fixture(t);
  await writeFile(env.PREVIEW_CODEX_CLI_AUTH_FILE, JSON.stringify({ OPENAI_API_KEY: "fixture-only" }));
  await assert.rejects(previewConfigFromEnvironment(env), /dedicated native Codex ChatGPT login/);
});

test("preview rejects a foreign host, PR, stage or zone before opening auth files", async t => {
  const { env } = await fixture(t);
  await rm(env.PREVIEW_CLAUDE_AUTH_FILE);
  for (const change of [
    { POOL_ACCEPTANCE_ORIGIN: "https://attacker.example.invalid" },
    { POOL_ACCEPTANCE_ORIGIN: `${env.POOL_ACCEPTANCE_ORIGIN}/` },
    { PREVIEW_SMOKE_PULL_REQUEST: "18" },
    { PREVIEW_SMOKE_PULL_REQUEST: "017" },
    { ALCHEMY_STAGE: "production" },
    { TEST_STAGE_DOMAIN: "other.example.invalid" },
    { TEST_STAGE_DOMAIN: "preview.example.invalid:443" },
    { GITHUB_EVENT_PULL_REQUEST_NUMBER: "18" },
  ]) {
    await assert.rejects(previewConfigFromEnvironment({ ...env, ...change }), error => !String(error).includes("auth files"));
  }
  await assert.rejects(previewConfigFromEnvironment(env), /private regular JSON/);
});

test("a supplied trusted manifest must match the seeded PR, stage, origin and native context", async t => {
  const { root, env } = await fixture(t);
  const path = join(root, "manifest.json");
  const manifest = { version: 1, phase: "seeded", pullRequest: 17, stage: env.ALCHEMY_STAGE,
    origin: env.POOL_ACCEPTANCE_ORIGIN, organizationId: env.PREVIEW_SMOKE_ORGANIZATION_ID, poolAppId: env.PREVIEW_SMOKE_POOL_APP_ID };
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  const configured = { ...env, POOL_ACCEPTANCE_PREVIEW_MANIFEST_FILE: path };
  assert.equal((await previewConfigFromEnvironment(configured)).origin, env.POOL_ACCEPTANCE_ORIGIN);
  for (const change of [{ pullRequest: 18 }, { stage: "test-pr-18" }, { origin: "https://attacker.example.invalid" },
    { phase: "deployed" }, { organizationId: "wrong-org" }, { poolAppId: "wrong-app" }]) {
    await writeFile(path, JSON.stringify({ ...manifest, ...change }));
    await assert.rejects(previewConfigFromEnvironment(configured), /manifest does not match/);
  }
});
