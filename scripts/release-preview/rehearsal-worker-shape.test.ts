import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeDurableObjectTags } from "alchemy/Cloudflare/Workers";
import { checkWorkerShape, type WorkerShape } from "./rehearsal-worker-shape.ts";

const worker = "rehearsal-poolworker";
const identity = ["alchemy:stack:basalt-rehearsal", "alchemy:stage:test-rehearsal-81231", "alchemy:id:PoolWorker"];
const dos = (...classes: string[]) => encodeDurableObjectTags(classes.map((name) => ({ logicalId: name, className: name })));
const bindings = [
  { type: "durable_object_namespace", name: "PoolContainer", class_name: "PoolContainer" },
  { type: "durable_object_namespace", name: "TOOLS", class_name: "Tools", script_name: "tools-worker" },
];
const container = { id: "container-ns", class: "PoolContainer", script: worker, use_sqlite: true };
const baselineShape: WorkerShape = {
  tags: [...identity, ...dos("PoolContainer")],
  version: { resources: { script_runtime: { compatibility_date: "2026-09-08" }, bindings } },
  namespaces: [container],
};
const releasedShape: WorkerShape = {
  tags: [...identity, ...dos("PoolContainer", "PoolRuntimeBlue", "PoolRuntimeGreen")],
  version: { resources: { script_runtime: {}, bindings } },
  namespaces: [
    container,
    { id: "blue-ns", class: "PoolRuntimeBlue", script: worker, use_sqlite: true },
    { id: "green-ns", class: "PoolRuntimeGreen", script: worker, use_sqlite: true },
  ],
};

test("production's untagged PoolWorker shape is accepted and anything else refuses before the release", () => {
  const record = checkWorkerShape(baselineShape, worker, "baseline");
  assert.deepEqual(record, { phase: "baseline", classes: {}, containerNamespace: "container-ns" });
  const cases: Array<[string, WorkerShape]> = [
    ["migration tag", { ...baselineShape, tags: [...baselineShape.tags, "alchemy:migration-tag:v1"] }],
    ["version migration tag", { ...baselineShape, version: { resources: { script_runtime: { migration_tag: "v1" }, bindings } } }],
    ["exports", { ...baselineShape, version: { ...baselineShape.version, exports: [] } }],
    ["no cross-script binding", { ...baselineShape, version: { resources: { bindings: bindings.slice(0, 1) } } }],
    ["fleet class already", { ...baselineShape, namespaces: releasedShape.namespaces }],
    ["missing identity tag", { ...baselineShape, tags: baselineShape.tags.slice(1) }],
  ];
  for (const [name, shape] of cases) assert.throws(() => checkWorkerShape(shape, worker, "baseline"), /shape refused/, name);
});

test("after the release both fleet classes exist untagged and PoolContainer keeps its namespace", () => {
  const baseline = checkWorkerShape(baselineShape, worker, "baseline");
  const released = checkWorkerShape(releasedShape, worker, "classes", baseline);
  assert.deepEqual(released.classes, { PoolRuntimeBlue: "blue-ns", PoolRuntimeGreen: "green-ns" });
  // A later plain deploy must leave every namespace as it was.
  assert.deepEqual(checkWorkerShape(releasedShape, worker, "classes", released), released);
  const moved = { ...releasedShape, namespaces: [{ ...container, id: "new-ns" }, ...releasedShape.namespaces.slice(1)] };
  assert.throws(() => checkWorkerShape(moved, worker, "classes", baseline), /PoolContainer namespace changed/);
  const recreated = { ...releasedShape, namespaces: [container, { ...releasedShape.namespaces[1]!, id: "blue-2" }, releasedShape.namespaces[2]!] };
  assert.throws(() => checkWorkerShape(recreated, worker, "classes", released), /changed the fleet class namespaces/);
  assert.throws(() => checkWorkerShape({ ...releasedShape, tags: [...identity, ...dos("PoolContainer")] }, worker, "classes", baseline), /does not name PoolRuntimeBlue/);
});
