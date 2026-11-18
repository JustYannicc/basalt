import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNamespaceAttachment,
  decodeNamespaceBaseline,
  runtimeNamespaceAttachment,
} from "./provisioning-namespace.ts";
import {
  namespaceBaseline,
  runtimeDeclaration,
  runtimeNamespaceId,
} from "./test/provisioning-fixtures.ts";

test("a bootstrap attaches to the SQLite class the alchemy deploy created on a version with no exports", () => {
  const baseline = namespaceBaseline();
  assert.equal(baseline.version.exports, undefined);
  for (const name of ["PoolRuntime", "PoolRuntimeBlue", "PoolRuntimeGreen"] as const)
    assert.deepEqual(runtimeNamespaceAttachment(baseline, runtimeDeclaration(name)), {
      accountId: baseline.accountId,
      scriptName: baseline.scriptName,
      versionId: "baseline-version",
      className: name,
      binding: name,
      namespaceId: runtimeNamespaceId(name),
    });
});

test("a class the deploy has not created, or one already container-backed, is never attached", () => {
  assert.throws(
    () => runtimeNamespaceAttachment(namespaceBaseline([]), runtimeDeclaration("PoolRuntimeBlue")),
    /provisioning-namespace-baseline-unsupported/,
  );
  const baseline = namespaceBaseline();
  for (const linked of [
    { ...baseline, containers: [...baseline.containers, { className: "PoolRuntimeBlue" }] },
    decodeNamespaceBaseline({
      ...baseline,
      version: {
        ...baseline.version,
        containers: [...baseline.containers, { className: "PoolRuntimeBlue" }],
      },
    }),
  ])
    assert.throws(
      () => runtimeNamespaceAttachment(linked, runtimeDeclaration("PoolRuntimeBlue")),
      /provisioning-namespace-baseline-unsupported/,
    );
});

test("legacy storage, a crossed binding or another account refuses the attachment", () => {
  const baseline = namespaceBaseline();
  const legacy = {
    ...baseline,
    namespaces: baseline.namespaces.map((row) =>
      row.className === "PoolRuntimeBlue" ? { ...row, storage: "legacy-kv" as const } : row,
    ),
  };
  const crossed = decodeNamespaceBaseline({
    ...baseline,
    version: {
      ...baseline.version,
      bindings: baseline.version.bindings!.map((binding) =>
        binding.name === "PoolRuntimeBlue" && binding.type === "durable_object_namespace"
          ? { ...binding, namespaceId: runtimeNamespaceId("PoolRuntimeGreen") }
          : binding,
      ),
    },
  });
  for (const value of [legacy, crossed, { ...baseline, accountId: "9".repeat(32) }])
    assert.throws(
      () => runtimeNamespaceAttachment(value, runtimeDeclaration("PoolRuntimeBlue")),
      /provisioning-namespace-baseline-unsupported/,
    );
});

test("the application create refuses a namespace map, container link or version that moved since the freeze", () => {
  const baseline = namespaceBaseline();
  const attachment = runtimeNamespaceAttachment(baseline, runtimeDeclaration("PoolRuntimeGreen"));
  const observed = {
    accountId: baseline.accountId,
    scriptName: baseline.scriptName,
    versionId: "baseline-version",
    deploymentId: "deployment",
    namespaces: baseline.namespaces,
    containers: baseline.containers,
  };
  assert.equal(
    assertNamespaceAttachment(attachment, baseline, observed).namespaceId,
    runtimeNamespaceId("PoolRuntimeGreen"),
  );
  for (const drift of [
    { ...observed, versionId: "other-version" },
    { ...observed, containers: [...observed.containers, { className: "PoolRuntimeGreen" }] },
    {
      ...observed,
      namespaces: observed.namespaces.map((row) =>
        row.className === "PoolRuntimeBlue" ? { ...row, id: "crossed" } : row,
      ),
    },
  ])
    assert.throws(
      () => assertNamespaceAttachment(attachment, baseline, drift),
      /provisioning-input-drift/,
    );
});
