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
