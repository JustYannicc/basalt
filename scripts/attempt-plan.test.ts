import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAttemptPlanProof } from "./architecture/native-stack.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Commands that run on every plan by design. No resource reads their outcome. */
const everyPlan = {
  production: [
    "PoolBackendBudget",
    "PoolBackendBudgetRuntimeReady",
    "PoolImagePublicationReceipt",
    "ToolsBackendBudget",
  ],
  preview: ["PoolBackendBudget", "PoolBackendBudgetRuntimeReady", "PreviewAuthSeed"],
};

/** Commands that run once per release attempt, and a resource that reads each one's outcome. */
const oncePerAttempt = {
  production: {
    commands: ["AppSourceNamespace", "Migrations", "PoolDatabase", "RuntimeDatabaseBudget"],
    readers: ["Router", "PoolWorker"],
  },
  preview: {
    commands: ["AppSourceNamespace", "Migrations", "PoolDatabase", "PoolDatabaseBudget"],
    readers: ["Router", "PoolWorker", "DatabaseConnection", "PoolModelDatabaseConnection"],
  },
};

for (const shape of ["production", "preview"] as const)
  test(
    `${shape}: a second plan of the same release attempt changes no resource`,
    { timeout: 80_000 },
    () => {
      const proof = discoverAttemptPlanProof(root, shape);
      assert.deepEqual(
        { failed: proof.failed, detail: (proof as { detail?: string }).detail },
        { failed: undefined, detail: undefined },
      );
      assert.ok(proof.resources > 50, "the whole stack is planned, not a part of it");
      assert.deepEqual(
        proof.secondPlan.filter((row) => !row.type.startsWith("Command.")),
        [],
        "a resource still plans as an update right after an apply",
      );
      assert.deepEqual(
        proof.secondPlan.map((row) => row.id),
        everyPlan[shape],
        "only the commands that run on every plan remain, and nothing reads them",
      );

      const next = new Map(proof.nextAttempt.map((row) => [row.id, row.action]));
      for (const id of [...oncePerAttempt[shape].commands, ...oncePerAttempt[shape].readers])
        assert.equal(next.get(id), "update", `${id} runs again with a new attempt id`);
    },
  );
