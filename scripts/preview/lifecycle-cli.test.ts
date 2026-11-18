import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("a failed lifecycle step tells the log why it stopped", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./lifecycle.ts", import.meta.url)), "plan", "not-a-number"],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Preview lifecycle step failed: Error: /);
  assert.match(
    result.stderr,
    /\n {2}why: It carries no cause, so its message is all that is known\./,
  );
  assert.match(
    result.stderr,
    /\n::error title=Preview lifecycle step failed::Preview lifecycle step failed/,
  );
  assert.match(result.stderr, /\nRemote provider absence is not established\n$/);
});
