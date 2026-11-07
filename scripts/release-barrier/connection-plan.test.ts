import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverConnectionPlanProof } from "../architecture/native-stack.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("the actual production connection stays unchanged across release Command attempts", () => {
  const proof = discoverConnectionPlanProof(root);
  assert.equal(proof.action, "noop");
  assert.equal(proof.candidateOriginResolved, true);
  assert.equal(proof.storedOriginResolved, true);
  assert.equal(proof.resolvedOriginEqual, true);
  assert.equal(proof.resolvedConfigEqual, true);
  assert.equal(proof.connectionWrites, 0);
  assert.equal(proof.budgetAction, "update");
  assert.equal(proof.migrationAction, "update");
  assert.equal(proof.databasePhaseContainsMigrations, true);
  assert.equal(proof.databasePhaseContainsBudget, true);
  assert.equal(proof.refusal, null);
  assert.ok(!proof.dependencies.includes("Migrations"));
  assert.ok(!proof.dependencies.includes("RuntimeDatabaseBudget"));
});

for (const change of ["origin", "limit", "tls"] as const) {
  test(`an actual production ${change} change remains unsupported before live effects`, () => {
    const proof = discoverConnectionPlanProof(root, change);
    assert.equal(proof.action, "update");
    assert.equal(proof.refusal, "unsupported-resource-update");
    assert.equal(proof.connectionWrites, 0);
    assert.equal(proof.commandRuns, 0);
  });
}

test("the actual pool connection stays unchanged across release Command attempts", () => {
  const proof = discoverConnectionPlanProof(root, undefined, "PoolModelDatabaseConnection");
  assert.deepEqual(proof.connectionIds, ["DatabaseConnection", "PoolModelDatabaseConnection"]);
  assert.equal(proof.action, "noop");
  assert.equal(proof.candidateOriginResolved, true);
  assert.equal(proof.storedOriginResolved, true);
  assert.equal(proof.resolvedOriginEqual, true);
  assert.equal(proof.resolvedConfigEqual, true);
  assert.equal(proof.connectionWrites, 0);
  assert.equal(proof.poolAction, "update");
  assert.ok(proof.poolWorkerDependencies.includes("PoolDatabase"));
  assert.ok(proof.poolWorkerDependencies.includes("RuntimeDatabaseBudget"));
  assert.equal(proof.databasePhaseContainsPool, true);
  assert.equal(proof.databasePhaseContainsMigrations, true);
  assert.equal(proof.databasePhaseContainsBudget, true);
  assert.equal(proof.refusal, null);
  for (const command of ["PoolDatabase", "Migrations", "RuntimeDatabaseBudget"])
    assert.ok(!proof.dependencies.includes(command));
});

for (const change of ["origin", "limit", "tls"] as const) {
  test(`an actual pool ${change} change remains unsupported before live effects`, () => {
    const proof = discoverConnectionPlanProof(root, change, "PoolModelDatabaseConnection");
    assert.equal(proof.action, "update");
    assert.equal(proof.refusal, "unsupported-resource-update");
    assert.equal(proof.connectionWrites, 0);
    assert.equal(proof.commandRuns, 0);
  });
}

for (const connection of ["DatabaseConnection", "PoolModelDatabaseConnection"] as const) {
  test(`an actual ${connection} identity change refuses replacement before live effects`, () => {
    const proof = discoverConnectionPlanProof(root, "name", connection);
    assert.equal(proof.action, "replace");
    assert.equal(proof.refusal, "new-or-unsettled-resource");
    assert.equal(proof.connectionWrites, 0);
    assert.equal(proof.commandRuns, 0);
  });
}
