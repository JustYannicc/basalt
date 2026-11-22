import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declaration, laneSubject, stageLabel } from "./stage.ts";

test("a label names one mode and one of six lanes", () => {
  assert.deepEqual(stageLabel("stage-plan"), { mode: "plan", lane: 1 });
  assert.deepEqual(stageLabel("stage-apply-3"), { mode: "apply", lane: 3 });
  assert.deepEqual(stageLabel("stage-baseline-4"), { mode: "baseline", lane: 4 });
  assert.deepEqual(stageLabel("stage-baseline-5"), { mode: "baseline", lane: 5 });
  assert.deepEqual(stageLabel("stage-baseline-6"), { mode: "baseline", lane: 6 });
  assert.deepEqual(stageLabel("stage-classplan-6"), { mode: "classplan", lane: 6 });
  assert.deepEqual(stageLabel("stage-stateread-6"), { mode: "stateread", lane: 6 });
  assert.deepEqual(stageLabel("stage-redrelease-6"), { mode: "redrelease", lane: 6 });
  assert.deepEqual(stageLabel("stage-retry-6"), { mode: "retry", lane: 6 });
  assert.equal(stageLabel("stage-apply-7"), undefined);
  assert.equal(stageLabel("stage-nuke"), undefined);
  assert.equal(stageLabel("release-rehearsal"), undefined);
  assert.throws(() => laneSubject(7), /lane is 1 to 6/);
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

test("the public record keeps no refused command's own text", async () => {
  const { publicRecord } = await import("./stage.ts");
  const record = {
    mode: "redrelease",
    device: { failed: "Command failed: --origin https://app.rehearsal-6.example.dev --pool app_x" },
    rollback: { exit: 1, refused: "WorkerVersionRefusal: host app.rehearsal-6.example.dev" },
    planRefused: "Release stopped in plan: names a host",
    steps: [{ exit: 4, refused: "secret-shaped detail" }],
    poolWorkerVersions: { count: 1, numbers: [10] },
  };
  const text = JSON.stringify(publicRecord(record));
  for (const leak of [
    "example.dev",
    "app_x",
    "WorkerVersionRefusal",
    "secret-shaped",
    "names a host",
  ])
    assert.equal(text.includes(leak), false, leak);
  // What is not a refusal's text stays as it was.
  assert.match(text, /"count":1/u);
  assert.match(text, /"exit":1/u);
  assert.match(text, /kept privately/u);
});

test("only a rollback with a named policy gets POLICY, as release.yml's job env names it", async () => {
  const { rollbackPolicyEnv } = await import("./stage.ts");
  assert.deepEqual(rollbackPolicyEnv("rollback", "code-stage"), {
    POLICY: "scripts/release/policies/code-stage.json",
  });
  // Without a policy the entry reads none and forces nothing.
  assert.deepEqual(rollbackPolicyEnv("rollback", null), {});
  assert.deepEqual(rollbackPolicyEnv("rollback", undefined), {});
  // The other commands take theirs as --policy; POLICY is the rollback's alone.
  for (const command of ["plan", "deploy", "apply", "serving", "boot", "accept"])
    assert.deepEqual(rollbackPolicyEnv(command, "code-stage"), {});
});
