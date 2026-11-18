// Regression: provisioning-class-refusals (the bootstrap preflight refuses class steps alchemy could not write)
import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapNamespacePlan, declaredNamespaceId } from "./runtime-bootstrap-preflight.ts";
import { decodeDeclaredChanges } from "./declared-change-schema.ts";
import { repositoryDeclarations } from "./test/repository-declarations.ts";
import { decodeNamespaceBaseline } from "./provisioning-namespace.ts";
import { namespaceBaseline } from "./test/provisioning-fixtures.ts";

const declarations = await repositoryDeclarations();
const accountId = "1".repeat(32);
// The first release's controller phase: no color has an image yet, so only PoolContainer is linked.
const plannedContainers = ["PoolContainer"];

test("the repository declares both fleet classes on PoolWorker, so the bootstrap attaches to what the deploy creates", () => {
  const plans = bootstrapNamespacePlan({
    baseline: namespaceBaseline([]),
    accountId,
    colors: ["blue", "green"],
    declarations,
    plannedContainers,
  });
  assert.deepEqual(
    plans.map(({ color, source, attachment }) => [color, source, attachment.namespaceId]),
    [
      ["blue", "declared", declaredNamespaceId("PoolRuntimeBlue")],
      ["green", "declared", declaredNamespaceId("PoolRuntimeGreen")],
    ],
  );
});

test("a Worker on declarative exports cannot take the class migration, so the bootstrap refuses", () => {
  const baseline = namespaceBaseline([]);
  const exportsWorker = decodeNamespaceBaseline({
    ...baseline,
    version: {
      ...baseline.version,
      exports: {
        PoolContainer: {
          type: "durable-object",
          storage: "sqlite",
          container: "PoolContainer",
          state: "created",
        },
      },
    },
  });
  assert.throws(
    () =>
      bootstrapNamespacePlan({
        baseline: exportsWorker,
        accountId,
        colors: ["blue"],
        declarations,
        plannedContainers,
      }),
    /provisioning-class-not-declared/,
  );
});

test("a name already bound or container-linked is never treated as a class the deploy will add", () => {
  const baseline = namespaceBaseline([]);
  const linked = {
    ...baseline,
    containers: [...baseline.containers, { className: "PoolRuntimeGreen" }],
  };
  assert.throws(
    () =>
      bootstrapNamespacePlan({
        baseline: linked,
        accountId,
        colors: ["green"],
        declarations,
        plannedContainers,
      }),
    /provisioning-class-not-declared/,
  );
});

test("alchemy's planned container links must equal the live Worker's, or the class step would refuse", () => {
  for (const planned of [["PoolContainer", "PoolRuntimeBlue"], []])
    assert.throws(
      () =>
        bootstrapNamespacePlan({
          baseline: namespaceBaseline([]),
          accountId,
          colors: ["blue", "green"],
          declarations,
          plannedContainers: planned,
        }),
      /provisioning-class-step-containers-mismatch/,
    );
});

test("green bootstraps on the Worker blue's bind phase left, so it attaches after blue's link", () => {
  const plans = bootstrapNamespacePlan({
    baseline: namespaceBaseline([]),
    accountId,
    colors: ["blue", "green"],
    declarations,
    plannedContainers,
  });
  assert.deepEqual(
    plans.map(({ attachment, containers }) => [attachment.className, containers]),
    [
      ["PoolRuntimeBlue", ["PoolContainer"]],
      ["PoolRuntimeGreen", ["PoolContainer", "PoolRuntimeBlue"]],
    ],
  );
});

test("an entry that declares only blue would break its own record once green binds", () => {
  const blueOnly = decodeDeclaredChanges({
    ...declarations,
    changes: declarations.changes.map((entry) =>
      entry.action === "add-sqlite-class"
        ? {
            ...entry,
            newSqliteClasses: ["PoolRuntimeBlue"],
            addedBindings: entry.addedBindings.filter(
              (binding) => binding.name === "PoolRuntimeBlue",
            ),
          }
        : entry,
    ),
  });
  assert.throws(
    () =>
      bootstrapNamespacePlan({
        baseline: namespaceBaseline(["PoolRuntimeGreen"]),
        accountId,
        colors: ["blue", "green"],
        declarations: blueOnly,
        plannedContainers,
      }),
    /provisioning-class-record-container-drift/,
  );
});
