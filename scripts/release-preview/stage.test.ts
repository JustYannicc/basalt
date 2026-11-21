import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declaration, laneSubject, stageLabel } from "./stage.ts";

test("a label names one mode and one of five lanes", () => {
  assert.deepEqual(stageLabel("stage-plan"), { mode: "plan", lane: 1 });
  assert.deepEqual(stageLabel("stage-apply-3"), { mode: "apply", lane: 3 });
  assert.deepEqual(stageLabel("stage-baseline-4"), { mode: "baseline", lane: 4 });
  assert.deepEqual(stageLabel("stage-baseline-5"), { mode: "baseline", lane: 5 });
  assert.equal(stageLabel("stage-apply-6"), undefined);
  assert.equal(stageLabel("stage-nuke"), undefined);
  assert.equal(stageLabel("release-rehearsal"), undefined);
  assert.throws(() => laneSubject(6), /lane is 1 to 5/);
});

test("the baseline declares no fleet classes and the cutover builds both colours", () => {
  assert.deepEqual(declaration.baseline, { POOL_FLEET_CLASSES: "absent" });
  assert.deepEqual(declaration.cutover, {
    POOL_FLEET_CLASSES: "declared",
    POOL_FLEET_BUILD: "true",
  });
});

test("no stage path runs the Alchemy CLI with --yes", () => {
  for (const file of ["scripts/preview/lifecycle.ts", "scripts/release-preview/stage.ts"]) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /"--yes"/u, file);
  }
});
