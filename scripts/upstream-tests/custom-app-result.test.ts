import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("CustomAppForm preserves inferred and explicit richer mutation results", () => {
  const result = spawnSync(
    fileURLToPath(new URL("../../.upstream/node_modules/.bin/tsc-rs", import.meta.url)),
    [
      "--noEmit",
      "-p",
      fileURLToPath(new URL("fixtures/custom-app-result/tsconfig.json", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
