import assert from "node:assert/strict";
import { test } from "node:test";
import { ownWorkers } from "./stage-diagnose.ts";

test("ownWorkers reads only this stage's Workers, by tag and by name", () => {
  const scripts = [
    {
      id: "basalt-rehearsal-poolworker-test-rehearsal-2-abc",
      tags: ["alchemy:stage:test-rehearsal-2"],
    },
    { id: "basalt-rehearsal-api-test-rehearsal-2-def", tags: ["alchemy:stage:test-rehearsal-2"] },
    { id: "basalt-poolworker-production-xyz", tags: ["alchemy:stage:production"] },
    { id: "basalt-poolworker-production-tagged", tags: ["alchemy:stage:test-rehearsal-2"] },
    { id: "basalt-rehearsal-api-test-rehearsal-1-ghi", tags: ["alchemy:stage:test-rehearsal-1"] },
  ];
  assert.deepEqual(ownWorkers(scripts, "test-rehearsal-2"), [
    "basalt-rehearsal-poolworker-test-rehearsal-2-abc",
    "basalt-rehearsal-api-test-rehearsal-2-def",
  ]);
});
