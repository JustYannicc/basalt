import assert from "node:assert/strict";
import { test } from "node:test";
import { stageWorker } from "./stage-diagnose.ts";

const tagged = (id: string, stage: string | undefined, logicalId: string) => ({
  id,
  tags: [...(stage ? [`alchemy:stage:${stage}`] : []), `alchemy:id:${logicalId}`],
});

test("a stage Worker is the one carrying both this stage's tag and its logical id, whatever its name", () => {
  const scripts = [
    // This stage's names do not carry the stage token; the tags decide.
    tagged(
      "basalt-rehearsal-poolworker-teubpl67o7745xv5lmvet3ht42",
      "test-rehearsal-2",
      "PoolWorker",
    ),
    tagged("basalt-rehearsal-router-k2f0", "test-rehearsal-2", "Router"),
    tagged("basalt-rehearsal-appoutbound-x9", "test-rehearsal-2", "AppOutbound"),
  ];
  assert.equal(
    stageWorker(scripts, "test-rehearsal-2", "PoolWorker"),
    "basalt-rehearsal-poolworker-teubpl67o7745xv5lmvet3ht42",
  );
  assert.equal(stageWorker(scripts, "test-rehearsal-2", "Router"), "basalt-rehearsal-router-k2f0");
});

test("(a) a Worker with the right logical id and no stage tag is not picked", () => {
  const scripts = [tagged("basalt-poolworker-untagged", undefined, "PoolWorker")];
  assert.throws(
    () => stageWorker(scripts, "test-rehearsal-2", "PoolWorker"),
    /no PoolWorker Worker of this stage/u,
  );
});

test("(b) a Worker carrying another stage's tag is not picked", () => {
  const scripts = [
    tagged("basalt-poolworker-production", "production", "PoolWorker"),
    tagged("basalt-rehearsal-poolworker-lane1", "test-rehearsal-1", "PoolWorker"),
  ];
  assert.throws(
    () => stageWorker(scripts, "test-rehearsal-2", "PoolWorker"),
    /no PoolWorker Worker of this stage/u,
  );
});

test("(c) two Workers matching one logical id refuse instead of picking one", () => {
  const scripts = [
    tagged("basalt-rehearsal-poolworker-a", "test-rehearsal-2", "PoolWorker"),
    tagged("basalt-rehearsal-poolworker-b", "test-rehearsal-2", "PoolWorker"),
  ];
  assert.throws(
    () => stageWorker(scripts, "test-rehearsal-2", "PoolWorker"),
    /2 PoolWorker Workers carry this stage/u,
  );
});
