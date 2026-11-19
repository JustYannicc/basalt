import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("the serialized restore recovers both readers, preserves native state and refuses drift, incomplete history and uncertain replay", () => {
  const result = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./test/journal-restore-proof.mjs", import.meta.url))],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.match(result, /__JOURNAL_RESTORE_PROOF_PASS__/);
});
