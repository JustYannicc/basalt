import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("the unprepared production workflow saves safe refusals without installed dependencies", () => {
  const checkout = mkdtempSync(join(tmpdir(), "production-ops-loading-"));
  try {
    for (const path of ["package.json", "brand.ts", "scripts/production-ops", "src/pool"]) {
      const destination = join(checkout, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, path), destination, {
        recursive: true,
        filter: (source) => !source.split("/").includes("node_modules"),
      });
    }
    assert.equal(existsSync(join(checkout, "node_modules")), false);
    for (const ref of ["refs/heads/fixture", "refs/heads/main"]) {
      const output = join(checkout, ref.endsWith("main") ? "main" : "branch");
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "data:text/javascript,globalThis.fetch=()=>{throw new Error('Unexpected network request')}",
          "scripts/production-ops/run.ts",
        ],
        {
          cwd: checkout,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            GITHUB_REF: ref,
            GITHUB_EVENT_NAME: "workflow_dispatch",
            OPS_ACTION: "inventory",
            OPS_SELECTION: "retained-frameworks",
            POOL_APP_SIGNING_KEY: "invalid-fixture-key",
            OPS_OUTPUT_DIRECTORY: output,
          },
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Production operation failed\. Inspect failure\.json/);
      assert.deepEqual(JSON.parse(readFileSync(join(output, "failure.json"), "utf8")), {
        format: "basalt-production-ops-failure-v1",
        category: "config",
        phase: "config",
      });
      assert.equal(existsSync(join(output, "operation.json")), false);
    }
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
