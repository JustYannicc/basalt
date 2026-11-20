import assert from "node:assert/strict";
import { test } from "node:test";
import { disposableStageNames, stackNameForStage } from "./rehearsal-stage.ts";

test("STAGE-ONLY OVERLAY: a rehearsal stage plans its own stack and names, production and PRs keep theirs", () => {
  assert.equal(stackNameForStage("test-rehearsal-2"), "basalt-rehearsal");
  for (const stage of ["production", "test-pr-7", undefined, "test-rehearsal-0"])
    assert.equal(stackNameForStage(stage), "basalt", String(stage));
  assert.deepEqual(disposableStageNames("test-rehearsal-2"), {
    slug: "rehearsal-2",
    sourceNamespace: "basalt-preview-rehearsal-2-apps",
    databaseName: "basalt-preview-rehearsal-2",
  });
  assert.deepEqual(disposableStageNames("test-pr-7"), {
    slug: "pr-7",
    sourceNamespace: "basalt-preview-pr-7-apps",
    databaseName: "basalt-preview-pr-7",
  });
  assert.equal(disposableStageNames("production"), undefined);
  assert.equal(disposableStageNames("scale-1"), undefined);
  for (const stage of ["test-rehearsal-0", "test-rehearsal-x", "test-pr-0"])
    assert.throws(() => disposableStageNames(stage), /malformed/u, stage);
});
