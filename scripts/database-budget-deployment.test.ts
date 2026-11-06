import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverReleasePhaseProof } from "./architecture/native-stack.ts";

test(
  "the real budget dependency consumes runtime readiness after the deployed Worker",
  { timeout: 40_000 },
  () => {
    const proof = discoverReleasePhaseProof(fileURLToPath(new URL("..", import.meta.url)));
    const readiness = proof.resources.find((node) => node.id === "PoolBackendBudgetRuntimeReady");
    const budget = proof.resources.find((node) => node.id === "PoolBackendBudget");
    assert.ok(readiness, "readiness must be a real resource in the deployed stack");
    assert.ok(budget);
    assert.ok(readiness.dependencies.includes("PoolWorker"));
    assert.ok(
      budget.dependencies.includes("PoolBackendBudgetRuntimeReady"),
      "Worker hash alone cannot start the verifier",
    );
  },
);
