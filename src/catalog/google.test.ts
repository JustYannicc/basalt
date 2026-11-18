import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Google's Gmail tools send attachments and schedule sends as served, against the published Google emulator", () => {
  assert.match(
    execFileSync("bun", ["scripts/connectors-tests/gmail-tools.mjs", "google"], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      timeout: 55_000,
    }),
    /checks passed against the published Google emulator/,
  );
});
