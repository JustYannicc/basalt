import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual Alchemy provider defers all writes to exact-version activation and preserves the ordinary upload path", (context) => {
  const scratch = mkdtempSync(join(tmpdir(), "barrier-provider-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const result = spawnSync(
    "bun",
    [fileURLToPath(new URL("./provider-proof.mjs", import.meta.url)), scratch],
    {
      env: {
        PATH: process.env.PATH,
        CI: "true",
        DO_NOT_TRACK: "1",
        ALCHEMY_HOME: join(scratch, "auth"),
        TMPDIR: scratch,
      },
      encoding: "utf8",
      timeout: 40_000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const line = result.stdout.split("\n").find((line) => line.startsWith("__PROOF__"));
  assert.ok(line, "Provider proof must emit its result");
  const proof = JSON.parse(line.slice("__PROOF__".length));
  assert.ok(proof.hook.before.every((call: string) => call.startsWith("GET:")));
  assert.deepEqual(
    proof.hook.after.filter((call: string) => !call.startsWith("GET:")),
    ["POST:/scripts/fixture-worker/deployments"],
  );
  assert.equal(proof.hook.versionId, "accepted-version");
  assert.equal(proof.hook.deploymentId, "exact-deployment");
  assert.ok(proof.hook.files.some((file: { hasFrozen: boolean }) => file.hasFrozen));
  assert.deepEqual(
    proof.ordinary.after.filter((call: string) => !call.startsWith("GET:")),
    ["PUT:/scripts/fixture-worker"],
  );
  assert.ok(proof.ordinary.mainModule);
  assert.equal(proof.hook.frozenHash, proof.hook.activatedHash);
  assert.equal(proof.version.metadata.keep_assets, true);
  assert.equal(proof.version.metadata.assets.config._headers, "/assets/*\n X-Fixture: preserved");
  assert.equal(proof.version.metadata.assets.config._redirects, "/old /new 301");
  assert.deepEqual(proof.version.metadata.assets.config.run_worker_first, ["/api/*"]);
  assert.equal(proof.version.inherit, "strict");
});
