import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeNamespacesMatch } from "./declared-class-contract.ts";

// PoolWorker's real settings carry one local class binding per class and one binding to a class
// another Worker owns, with both script_name and namespace_id.
const observed = {
  scriptName: "PoolWorker",
  settings: {
    bindings: [
      {
        type: "durable_object_namespace",
        name: "PoolContainer",
        className: "PoolContainer",
        namespaceId: "container-namespace",
      },
      {
        type: "durable_object_namespace",
        name: "PoolRuntimeBlue",
        className: "PoolRuntimeBlue",
        namespaceId: "blue-namespace",
      },
      {
        type: "durable_object_namespace",
        name: "BulkUsageImport",
        className: "ArtifactsTokenCoordinator",
        scriptName: "synthetic-other-worker",
        namespaceId: "foreign-namespace",
      },
      { type: "plain_text", name: "POOL_PRESERVE_LEGACY_IMAGE", text: "true" },
    ],
  },
} as Parameters<typeof nativeNamespacesMatch>[1];
const local = { PoolContainer: "container-namespace", PoolRuntimeBlue: "blue-namespace" };
const activated = { ...local, ArtifactsTokenCoordinator: "foreign-namespace" };

test("the native row matches the class step's local map, or alchemy's map after activation", () => {
  assert.equal(nativeNamespacesMatch(local, observed), true);
  assert.equal(nativeNamespacesMatch(activated, observed), true);
});

test("a missing class, a changed id or a class the Worker does not bind is still drift", () => {
  for (const native of [
    { PoolContainer: "container-namespace" },
    { ArtifactsTokenCoordinator: "foreign-namespace", PoolContainer: "container-namespace" },
    { ...activated, PoolRuntimeBlue: "other-namespace" },
    { ...local, ArtifactsTokenCoordinator: "other-namespace" },
    { ...activated, PoolRuntimeGreen: "green-namespace" },
    { ...local, Unbound: "unbound-namespace" },
    {},
    undefined,
  ])
    assert.equal(nativeNamespacesMatch(native, observed), false, JSON.stringify(native));
});
