import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewIdentity, requiredPreviewDeploySecrets } from "../environment.ts";
import { manifestPath } from "./checkpoint.ts";
import { executePreview } from "./run.ts";

for (const failDeploy of [false, true]) {
  test(`preview children keep subscription JSON private when deploy ${failDeploy ? "fails" : "succeeds"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "preview-run-environment-"));
    const source: NodeJS.ProcessEnv = {
      ...Object.fromEntries(requiredPreviewDeploySecrets.map(name => [name, "fixture-provider"])),
      PATH: process.env.PATH,
      RUNNER_TEMP: root,
      GITHUB_ACTIONS: "true",
      PREVIEW_MANIFEST_CHECKPOINTED: "1",
      TEST_STAGE_DOMAIN: "preview.example.invalid",
      PREVIEW_STATE_KEY: "12".repeat(32),
      PREVIEW_SMOKE_EMAIL: "preview@example.invalid",
      PREVIEW_SMOKE_PASSWORD: "fixture-preview-password",
      PREVIEW_CLAUDE_MODEL: "fixture-claude",
      PREVIEW_CODEX_MODEL: "fixture-codex",
      PREVIEW_CLAUDE_AUTH_JSON: '{"type":"claude","access_token":"fixture-private-claude"}',
      PREVIEW_CODEX_SUBSCRIPTION_AUTH_JSON: '{"type":"codex","access_token":"fixture-private-codex"}',
      PREVIEW_CODEX_CLI_AUTH_JSON: '{"auth_mode":"chatgpt","tokens":{}}',
      RELEASE_UPDATE_TOKEN: "fixture-private-repository-token",
      UNKNOWN_FUTURE_SECRET: "fixture-private-future-token",
    };
    const calls: string[] = [];
    const files: string[] = [];
    try {
      await mkdir(join(root, ".local", "previews"), { recursive: true });
      await writeFile(join(root, ".local", "candidate.json"), JSON.stringify({
        status: "candidate-allowed", pullRequest: 42, head: "a".repeat(40), base: "b".repeat(40),
      }));
      const manifest = { version: 1, ...previewIdentity(42, source), phase: "seeded",
        organizationId: "fixture-org", poolAppId: "fixture-pool" };
      await writeFile(manifestPath(root, 42), JSON.stringify(manifest));

      const run = executePreview(root, 42, source, async operation => {
        calls.push(operation.label);
        for (const name of ["PREVIEW_CLAUDE_AUTH_JSON", "PREVIEW_CODEX_SUBSCRIPTION_AUTH_JSON",
          "PREVIEW_CODEX_CLI_AUTH_JSON", "RELEASE_UPDATE_TOKEN", "UNKNOWN_FUTURE_SECRET"]) {
          assert.equal(operation.environment[name], undefined, `${operation.label} received ${name}`);
        }
        if (operation.label === "deploy") {
          assert.equal(operation.environment.PREVIEW_SMOKE_EMAIL, source.PREVIEW_SMOKE_EMAIL);
          assert.equal(operation.environment.PREVIEW_STATE_KEY, source.PREVIEW_STATE_KEY);
          assert.equal(operation.environment.CLOUDFLARE_API_TOKEN, source.CLOUDFLARE_API_TOKEN);
          if (failDeploy) throw new Error("fixture deployment failed");
        } else if (operation.label === "native-smoke") {
          assert.equal(operation.environment.CLOUDFLARE_API_TOKEN, undefined);
          for (const name of ["CLAUDE_AUTH", "CODEX_SUBSCRIPTION_AUTH", "CODEX_CLI_AUTH"]) {
            const path = operation.environment[`PREVIEW_${name}_FILE`]!;
            files.push(path);
            assert.equal(await readFile(path, "utf8"), source[`PREVIEW_${name}_JSON`]);
          }
          await writeFile(operation.environment.POOL_ACCEPTANCE_RESULT_PATH!, JSON.stringify({
            version: 1, mode: "preview", signIn: true, pool: true, cleanup: true,
            clients: ["claude", "codex"].map(client => ({ client, exit: 0, timeout: false,
              modelRequest: true, toolSearch: true, undo: true, revoke: true })),
          }));
        } else {
          assert.equal(operation.environment.PREVIEW_SMOKE_EMAIL, undefined);
          assert.equal(operation.environment.PREVIEW_SMOKE_PASSWORD, undefined);
          assert.equal(operation.environment.PREVIEW_STATE_KEY, source.PREVIEW_STATE_KEY);
        }
      });
      if (failDeploy) await assert.rejects(run, /fixture deployment failed/);
      else await run;
      assert.deepEqual(calls, failDeploy ? ["deploy", "destroy", "verify-absence"]
        : ["deploy", "native-smoke", "destroy", "verify-absence"]);
      for (const path of files) await assert.rejects(readFile(path), { code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
