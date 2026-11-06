import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyDatabaseBudget } from "./database-budget-verification.ts";

test("warm excess sessions are tolerated only within the rollout deadline", async () => {
  let clock = 0;
  let reads = 0;
  const counts = await verifyDatabaseBudget({
    databases: ["app", "pool"],
    now: () => clock,
    deadlineMs: 3,
    wait: async () => {
      clock++;
    },
    read: async () => [
      { database: "pool", connections: ++reads < 3 ? 7 : 5 },
      { database: "app", connections: 5 },
    ],
  });
  assert.equal(reads, 3);
  assert.equal(
    counts.reduce((sum, row) => sum + row.connections, 0),
    10,
  );
  await assert.rejects(
    verifyDatabaseBudget({
      databases: ["pool"],
      now: () => clock,
      deadlineMs: 3,
      wait: async () => {
        clock++;
      },
      read: async () => [{ database: "pool", connections: 6 }],
    }),
    /did not converge within 3ms/,
  );
});

test("another runtime database cannot silently extend the combined allocation", async () => {
  await assert.rejects(
    verifyDatabaseBudget({
      databases: ["app", "pool"],
      deadlineMs: 0,
      read: async () => [{ database: "other", connections: 1 }],
    }),
    /did not converge/,
  );
});
