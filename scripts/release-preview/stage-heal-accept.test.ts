import assert from "node:assert/strict";
import { test } from "node:test";
import { restartExpectArgs } from "./stage.ts";

const older =
  'if [ -n "$within" ]; then expect=(--expect restart --root-boot .local/release/root-boot.json --serving .local/release/serving.json --within "$within"); fi';
const newer =
  'if [ -n "$within" ]; then expect=(--expect restart --serving .local/release/serving.json --apply "${{ steps.apply.outcome }}"); fi';

test("restartExpectArgs follows the candidate's own release.yml form", () => {
  assert.deepEqual(
    restartExpectArgs({ workflow: older, bound: 420, serving: "/o/s.json", apply: "failure" }),
    ["--expect", "restart", "--serving", "/o/s.json", "--within", "420"],
  );
  assert.deepEqual(
    restartExpectArgs({ workflow: newer, bound: 420, serving: "/o/s.json", apply: "failure" }),
    ["--expect", "restart", "--serving", "/o/s.json", "--apply", "failure"],
  );
});

test("restartExpectArgs refuses a workflow with no restart acceptance, or a missing bound", () => {
  assert.throws(
    () => restartExpectArgs({ workflow: "run: true", bound: 420, serving: "s", apply: "success" }),
    /no root restart acceptance/u,
  );
  assert.throws(
    () => restartExpectArgs({ workflow: older, bound: undefined, serving: "s", apply: "success" }),
    /no restart bound/u,
  );
});
