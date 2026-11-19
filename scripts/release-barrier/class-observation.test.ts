import assert from "node:assert/strict";
import { test } from "node:test";
import { assertClassObservation } from "./class-observation.ts";
import type { ClassObservation } from "./declared-class-contract.ts";
import type { ClassRecord } from "./class-history.ts";
import { poolWorkerClassEntry } from "./test/repository-declarations.ts";

const entry = await poolWorkerClassEntry();
const tags = [
  "alchemy:stack:basalt",
  "alchemy:stage:production",
  "alchemy:id:PoolWorker",
  "alchemy:dos:PoolContainer;PoolRuntimeBlue;PoolRuntimeGreen",
];
const binding = (name: string, namespaceId: string) => ({
  type: "durable_object_namespace" as const,
  name,
  className: name,
  namespaceId,
});
const observation = (
  versionId: string,
  containers: readonly string[],
  classes: boolean,
): ClassObservation => ({
  accountId: "1".repeat(32),
  scriptName: "synthetic-worker",
  workerId: "synthetic-worker-identity",
  versionId,
  previewUrlsEnabled: false,
  containers: containers.map((className) => ({ className })),
  settings: {
    bindings: [
      binding("PoolContainer", "legacy-namespace"),
      ...(classes
        ? [
            binding("PoolRuntimeBlue", "blue-namespace"),
            binding("PoolRuntimeGreen", "green-namespace"),
          ]
        : []),
    ],
    tags,
    annotations: { workersMessage: "basalt-declared:marker" },
  },
});
// What the controller code phase saved for PoolWorker: untagged, PoolContainer its only container.
const expanded = observation("expanded", ["PoolContainer"], true);
const saved: ClassRecord = {
  entry: "a".repeat(64),
  declaration: "b".repeat(64),
  candidate: "c".repeat(40),
  native: { instanceId: "instance", workerId: expanded.workerId, providerVersion: 0 },
  baseline: observation("baseline", ["PoolContainer"], false),
  marker: "basalt-declared:marker",
  content: "d".repeat(64),
  payload: "e".repeat(64),
  tags,
  recovery: { metadata: { mainModule: "worker.js" }, mainModule: "worker.js", files: [] },
  clone: {
    request: { accountId: expanded.accountId, workerId: expanded.scriptName },
    payload: "f".repeat(64),
    status: "removed",
  },
  status: "ready",
  observed: expanded,
};

test("a ready PoolWorker class accepts the next code phase binding the blue container", () => {
  assert.doesNotThrow(() =>
    assertClassObservation(
      entry,
      saved,
      observation("bind-blue", ["PoolContainer", "PoolRuntimeBlue"], true),
    ),
  );
  assert.doesNotThrow(() =>
    assertClassObservation(
      entry,
      saved,
      observation("bind-green", ["PoolContainer", "PoolRuntimeBlue", "PoolRuntimeGreen"], true),
    ),
  );
});

test("a ready class read refuses PoolContainer losing its container link", () => {
  assert.throws(
    () => assertClassObservation(entry, saved, observation("dropped", ["PoolRuntimeBlue"], true)),
    /declared-class-container-drift/,
  );
});

test("a ready class read refuses a container link to a class the entry does not declare", () => {
  assert.throws(
    () =>
      assertClassObservation(
        entry,
        saved,
        observation("unrelated", ["PoolContainer", "UnrelatedClass"], true),
      ),
    /declared-class-container-drift/,
  );
});

test("the class step's own read still requires linkage exactly as it was before the migration", () => {
  assert.throws(
    () =>
      assertClassObservation(
        entry,
        { ...saved, status: "acknowledged", observed: undefined },
        observation("expanded", ["PoolContainer", "PoolRuntimeBlue"], true),
        true,
      ),
    /declared-class-container-drift/,
  );
});
