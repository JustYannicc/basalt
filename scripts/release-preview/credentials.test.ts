import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSmokeSecrets, validateSmokeSecrets } from "./credentials.ts";

const secrets = {
  PREVIEW_SMOKE_EMAIL: "preview@example.invalid", PREVIEW_SMOKE_PASSWORD: "fixture-password",
  PREVIEW_CLAUDE_MODEL: "fixture-claude", PREVIEW_CODEX_MODEL: "fixture-codex",
  PREVIEW_CLAUDE_AUTH_JSON: '{"type":"claude","access_token":"private-fixture"}',
  PREVIEW_CODEX_SUBSCRIPTION_AUTH_JSON: '{"type":"codex"}',
  PREVIEW_CODEX_CLI_AUTH_JSON: '{"auth_mode":"chatgpt","tokens":{}}',
};

test("preview credentials become private files and leave the child environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-credentials-"));
  try {
    const env = await materializeSmokeSecrets(secrets, directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const name of ["CLAUDE_AUTH", "CODEX_SUBSCRIPTION_AUTH", "CODEX_CLI_AUTH"]) {
      assert.equal(env[`PREVIEW_${name}_JSON`], undefined);
      const path = env[`PREVIEW_${name}_FILE`]!;
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(await readFile(path, "utf8"), secrets[`PREVIEW_${name}_JSON` as keyof typeof secrets]);
    }
    await assert.rejects(materializeSmokeSecrets(secrets, directory), /EEXIST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing, malformed or real-person smoke identities fail without revealing values", () => {
  assert.throws(() => validateSmokeSecrets({}), /Missing preview smoke input/);
  for (const value of ["private-fixture", "[]", "null", "false"]) {
    assert.throws(() => validateSmokeSecrets({ ...secrets, PREVIEW_CLAUDE_AUTH_JSON: value }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
  assert.throws(() => validateSmokeSecrets({ ...secrets, PREVIEW_SMOKE_EMAIL: "person@example.test" }),
    /reserved example.invalid/);
});
