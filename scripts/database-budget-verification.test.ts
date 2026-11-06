import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyDatabaseBudget, backendCountSql } from "./database-budget-verification.ts";
import { DatabaseBudgetFailure, type BudgetReceipt } from "./database-budget-receipt.ts";
import type { RuntimeReady } from "../src/pool/deployment-readiness.ts";
const ready = (bootId = "boot-a", readyAt = 0): RuntimeReady => ({
  candidate: "a".repeat(40),
  workerInput: "b".repeat(64),
  imageHash: "image",
  desiredRevisionMatch: true,
  instanceId: "c".repeat(64),
  bootId,
  readyAt,
});

test("adoption later than 90 seconds gets the full 90 seconds after target readiness", async () => {
  let clock = 0,
    reads = 0,
    adopted = false;
  const counts = await verifyDatabaseBudget({
    databases: ["app", "pool"],
    now: () => clock,
    ready: async () => {
      if (!adopted) {
        clock += 120_000;
        adopted = true;
      }
      return ready("new", 120_000);
    },
    wait: async () => {
      clock += 30_000;
    },
    read: async () => {
      reads++;
      return [
        { database: "pool", connections: reads < 3 ? 6 : 5 },
        { database: "app", connections: 5 },
      ];
    },
  });
  assert.equal(clock, 180_000);
  assert.equal(reads, 3);
  assert.deepEqual(counts, [
    { database: "app", connections: 5 },
    { database: "pool", connections: 5 },
  ]);
});

test("a stuck sixth backend fails with exact counts and sample diagnostics", async () => {
  let clock = 0;
  await assert.rejects(
    verifyDatabaseBudget({
      databases: ["pool"],
      now: () => clock,
      ready: async () => ready(),
      wait: async () => {
        clock += 30_000;
      },
      read: async () => [{ database: "pool", connections: 6 }],
    }),
    (error) => {
      assert.ok(error instanceof DatabaseBudgetFailure);
      assert.equal(error.receipt.outcome, "over-budget-deadline");
      assert.equal(error.receipt.elapsedMs, 90_000);
      assert.equal(error.receipt.successfulSamples, 4);
      assert.deepEqual(error.receipt.counts, [{ database: "pool", connections: 6 }]);
      assert.equal(error.receipt.runtime?.bootId, "boot-a");
      return true;
    },
  );
});

test("a replacement invalidates the in-flight sample and re-establishes target readiness", async () => {
  let clock = 0,
    reads = 0,
    boot = "old";
  const snapshots: BudgetReceipt[] = [];
  const counts = await verifyDatabaseBudget({
    databases: ["pool"],
    now: () => clock,
    initialReady: ready("old"),
    ready: async () => ready(boot, clock),
    read: async () => {
      reads++;
      if (reads === 1) {
        boot = "new";
        clock = 80_000;
        return [];
      }
      return [{ database: "pool", connections: reads < 4 ? 6 : 5 }];
    },
    wait: async () => {
      clock += 30_000;
    },
    observed: (value) => snapshots.push(value),
  });
  assert.equal(reads, 4);
  assert.equal(clock, 140_000);
  assert.equal(
    snapshots.find((snapshot) => snapshot.successfulSamples === 1)?.runtime?.bootId,
    "new",
  );
  assert.deepEqual(counts, [{ database: "pool", connections: 5 }]);
});

test("only a successful complete query can yield an explicit zero for an absent database", async () => {
  assert.deepEqual(
    await verifyDatabaseBudget({ databases: ["app", "pool"], read: async () => [] }),
    [
      { database: "app", connections: 0 },
      { database: "pool", connections: 0 },
    ],
  );
  await assert.rejects(
    verifyDatabaseBudget({
      databases: ["pool"],
      read: async () => {
        throw { code: "42501" };
      },
    }),
    (error) => {
      assert.ok(error instanceof DatabaseBudgetFailure);
      assert.equal(error.receipt.counts, null);
      assert.equal(error.receipt.successfulSamples, 0);
      assert.equal(error.receipt.code, "42501");
      return true;
    },
  );
});
for (const rows of [
  [{ database: "other", connections: 1 }],
  [{ database: "pool", connections: -1 }],
  [{ database: "pool", connections: 1.1 }],
  [
    { database: "pool", connections: 2 },
    { database: "pool", connections: 3 },
  ],
]) {
  test(`invalid or unexpected observations fail immediately: ${JSON.stringify(rows)}`, async () => {
    await assert.rejects(
      verifyDatabaseBudget({ databases: ["pool"], read: async () => rows }),
      (error) => {
        assert.ok(error instanceof DatabaseBudgetFailure);
        assert.equal(error.receipt.outcome, "invalid-observation");
        assert.equal(error.receipt.counts, null);
        return true;
      },
    );
  });
}
test("all direct and pooled runtime clients are counted per database", () => {
  assert.match(backendCountSql, /usename = ANY\(\$1::text\[\]\)/);
  assert.match(backendCountSql, /backend_type = 'client backend'/);
  assert.match(backendCountSql, /GROUP BY datname/);
  assert.doesNotMatch(backendCountSql, /client_addr|application_name/);
});

test("repeated runtime replacements stay inside the fixed 270-second overall bound", async () => {
  let clock = 0,
    observations = 0,
    boot = "boot-0";
  await assert.rejects(
    verifyDatabaseBudget({
      databases: ["pool"],
      now: () => clock,
      overallDeadline: 270_000,
      ready: async () => ready(boot, clock),
      read: async () => {
        observations++;
        if (observations % 2 === 0) boot = `boot-${observations}`;
        return [{ database: "pool", connections: 6 }];
      },
      wait: async () => {
        clock += 60_000;
      },
    }),
    (error) => {
      assert.ok(error instanceof DatabaseBudgetFailure);
      assert.equal(error.receipt.outcome, "abort");
      assert.equal(error.receipt.counts?.[0]?.connections, 6);
      assert.ok(error.receipt.sampleRuntime?.bootId);
      assert.ok(clock >= 270_000 && clock <= 300_000);
      return true;
    },
  );
});
