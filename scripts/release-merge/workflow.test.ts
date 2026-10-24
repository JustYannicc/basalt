import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/release-merge.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

test("release merge gates share one non-canceling concurrency group", () => {
  const declarations = workflow.match(/^concurrency:\s*$/gm) ?? [];
  assert.equal(declarations.length, 1);
  const concurrency = workflow.match(/^concurrency:\n((?:[ \t].*\n)+)/m)?.[1] ?? "";
  assert.match(concurrency, /^  group: release-merge$/m);
  assert.match(concurrency, /^  cancel-in-progress: false$/m);
  assert.doesNotMatch(concurrency, /github\.event|pull_requests|head_sha/);
});
