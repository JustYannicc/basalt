import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewIdentity, requiredPreviewDeploySecrets } from "../environment.ts";
import { manifestPath } from "./checkpoint.ts";
import { executePreview } from "./run.ts";
import { scopedSmoke } from "./test/scoped.ts";

for (const failure of [undefined, "deploy", "smoke", "revoke", "destroy"] as const) {
  test(`scoped preview keeps production authority in its parent and cleans after ${failure ?? "success"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "preview-run-environment-"));
    const source: NodeJS.ProcessEnv = {
      ...Object.fromEntries(requiredPreviewDeploySecrets.map((name) => [name, "fixture-provider"])),
      PATH: process.env.PATH,
      RUNNER_TEMP: root,
      GITHUB_ACTIONS: "true",
      PREVIEW_MANIFEST_CHECKPOINTED: "1",
      TEST_STAGE_DOMAIN: "preview.example.invalid",
      PREVIEW_STATE_KEY: "12".repeat(32),
      PREVIEW_SMOKE_EMAIL: "preview@example.invalid",
      PREVIEW_SMOKE_PASSWORD: "fixture-preview-password",
      PREVIEW_POOL_ID: "production-pool",
      ORGANIZATION_ID: "production-org",
      OWNER_ID: "production-owner",
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      RELEASE_UPDATE_TOKEN: "fixture-private-repository-token",
      UNKNOWN_FUTURE_SECRET: "fixture-private-future-token",
    };
    const calls: string[] = [];
    let revokeCalls = 0;
    try {
      await mkdir(join(root, ".local", "previews"), { recursive: true });
      await writeFile(
        join(root, ".local", "candidate.json"),
        JSON.stringify({
          status: "candidate-allowed",
          pullRequest: 42,
          head: "a".repeat(40),
          base: "b".repeat(40),
        }),
      );
      const manifest = {
        version: 1,
        ...previewIdentity(42, source),
        phase: "seeded",
        organizationId: "fixture-org",
        poolAppId: "fixture-pool",
      };
      await writeFile(manifestPath(root, 42), JSON.stringify(manifest), { mode: 0o600 });
      const run = executePreview(
        root,
        42,
        source,
        async (operation) => {
          calls.push(operation.label);
          for (const name of [
            "POOL_APP_SIGNING_KEY",
            "PREVIEW_POOL_ID",
            "ORGANIZATION_ID",
            "OWNER_ID",
            "RELEASE_UPDATE_TOKEN",
            "UNKNOWN_FUTURE_SECRET",
          ])
            assert.equal(operation.environment[name], undefined, `${operation.label}: ${name}`);
          if (operation.label === "deploy") {
            assert.equal(operation.environment.PREVIEW_SMOKE_EMAIL, source.PREVIEW_SMOKE_EMAIL);
            assert.equal(operation.environment.PREVIEW_STATE_KEY, source.PREVIEW_STATE_KEY);
            if (failure === "deploy") throw new Error("fixture deployment failed");
          } else {
            assert.equal(operation.environment.PREVIEW_SMOKE_EMAIL, undefined);
            assert.equal(operation.environment.PREVIEW_SMOKE_PASSWORD, undefined);
            if (operation.label === failure) throw new Error("fixture cleanup failed");
          }
        },
        {
          openGrant: async (config) => {
            calls.push("grant");
            assert.equal(config.signingKey, source.POOL_APP_SIGNING_KEY);
            assert.equal(config.poolId, "production-pool");
            return {
              modelUrl: "http://127.0.0.1:45678",
              modelKey: "fixture-loopback-nonce",
              close: async () => {
                revokeCalls++;
                if (failure === "revoke") throw new Error("fixture revoke failed");
                return { revoked: true, unauthorized: true };
              },
              evidence: () => ({
                model: "claude-opus-5-5",
                requests: 2,
                planQuotaChecked: true,
                extraUsageDisabled: true,
              }),
            };
          },
          smoke: async (config, model) => {
            calls.push("smoke");
            assert.equal(config.poolAppId, "fixture-pool");
            assert.equal(model.modelKey, "fixture-loopback-nonce");
            if (failure === "smoke") throw new Error("fixture smoke failed");
            return scopedSmoke();
          },
        },
      );
      if (failure) await assert.rejects(run);
      else {
        await run;
        const receipt = JSON.parse(await readFile(join(root, "preview-receipt.json"), "utf8"));
        assert.equal(receipt.version, 2);
        assert.equal(receipt.coverage.clients[1].transport, "synthetic");
        assert.equal(receipt.poolGrant.unauthorized, true);
      }
      assert.equal(calls.includes("provider-account-setup"), false);
      assert.deepEqual(calls.slice(-2), ["destroy", "verify-absence"]);
      assert.equal(revokeCalls, failure === "deploy" ? 0 : 1);
      if (failure)
        await assert.rejects(readFile(join(root, "preview-receipt.json")), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
