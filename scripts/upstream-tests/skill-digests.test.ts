import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Carries that edit the Executor app's skill files must regenerate the digests telemetry uses to
// recognize them; the prepared tree is checked the way upstream's own `check` does.
test("the prepared tree's skill digests match its skill files", () => {
  const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
  const result = spawnSync(process.execPath, ["packages/app-templates/scripts/executor-intro.ts", "--check"], {
    cwd: upstream,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
