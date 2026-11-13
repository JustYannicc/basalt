import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import {
  prepareHomeSchema,
  HomeSchemaCommandError,
  type HomeSchemaResult,
  type HomeMigrationIdentity,
  type HomeMigrationReceipt,
} from "./home-schema-operation.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";
import { readSqlSchemaJournal, writeSqlSchemaJournal } from "./sql-schema-journal.ts";

const identity: HomeMigrationIdentity = {
  candidate: "a".repeat(40),
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageConfigDigest: `sha256:${"b".repeat(64)}`,
  baselineImageDigest: `sha256:${"c".repeat(64)}`,
  sourceInputHash: "a".repeat(16),
  baselineInputHash: "b".repeat(16),
};
const info = {
  format_version: 1 as const,
  target_version: 2,
  required_indexes: ["idx_usage_time"],
};
const pending: HomeSchemaResult = {
  format_version: 1,
  target_version: 2,
  previous_version: null,
  applied_version: 1,
  status: "pending",
  indexes_checked: false,
  pending_indexes: [],
  reason: "schema_pending",
};
const complete: HomeSchemaResult = {
  format_version: 1,
  target_version: 2,
  previous_version: null,
  applied_version: 2,
  status: "ready",
  indexes_checked: true,
  pending_indexes: [],
};
const migrated: HomeSchemaResult = { ...complete, previous_version: 1, status: "migrated" };

test("pending native schema persists intent and exact container ID before one write, then proves complete readiness", async () => {
  const records: HomeMigrationReceipt[] = [];
  let writes = 0;
  let checks = 0;
  const result = await prepareHomeSchema({
    identity,
    info,
    admit: () => true,
    record: async (value) => void records.push(value),
    commands: {
      check: async () => (++checks === 1 ? pending : complete),
      migrate: async (allocated) => {
        assert.equal(records.at(-1)!.state, "intent");
        await allocated?.("d".repeat(64));
        assert.equal(records.at(-1)!.containerId, "d".repeat(64));
        writes++;
        return migrated;
      },
    },
  });
  assert.equal(writes, 1);
  assert.equal(result.receipt.state, "migrated");
  assert.equal(result.proof.status, "ready");
  assert.deepEqual(
    records.map((value) => value.state),
    ["intent", "intent", "migrated"],
  );
});

test("full readiness skips the migrator, while same version with missing native indexes does not", async () => {
  let writes = 0;
  const skipped = await prepareHomeSchema({
    identity,
    info,
    admit: () => false,
    record: async () => {},
    commands: {
      check: async () => complete,
      migrate: async () => {
        writes++;
        return migrated;
      },
    },
  });
  assert.equal(skipped.receipt.state, "skipped");
  assert.equal(writes, 0);
  let checks = 0;
  const incomplete: HomeSchemaResult = {
    ...complete,
    status: "pending",
    pending_indexes: ["idx_usage_time"],
    reason: "indexes_pending",
  };
  const result = await prepareHomeSchema({
    identity,
    info,
    admit: () => true,
    record: async () => {},
    commands: {
      check: async () => (++checks === 1 ? incomplete : complete),
      migrate: async () => {
        writes++;
        return { ...migrated, previous_version: 2 };
      },
    },
  });
  assert.equal(result.receipt.state, "migrated");
  assert.equal(writes, 1);
});

test("unreviewed transitions and failed native index completion remain refused", async () => {
  let writes = 0;
  const denied = await prepareHomeSchema({
    identity,
    info,
    admit: () => false,
    record: async () => {},
    commands: {
      check: async () => pending,
      migrate: async () => {
        writes++;
        return migrated;
      },
    },
  });
  assert.equal(denied.receipt.reason, "unreviewed-transition");
  assert.equal(writes, 0);
  const partial: HomeSchemaResult = {
    ...complete,
    status: "pending",
    pending_indexes: ["idx_usage_time"],
    reason: "indexes_pending",
  };
  let checks = 0;
  const failed = await prepareHomeSchema({
    identity,
    info,
    admit: () => true,
    record: async () => {},
    commands: {
      check: async () => (++checks === 1 ? pending : partial),
      migrate: async () => {
        writes++;
        return { ...partial, status: "failed", previous_version: 1, reason: "migration_failed" };
      },
    },
  });
  assert.equal(failed.receipt.state, "failed");
  assert.equal(failed.receipt.after!.applied_version, 2);
  assert.equal(failed.proof.status, "pending");
  assert.deepEqual(failed.proof.pendingIndexes, ["idx_usage_time"]);
});

test("durable independent journal prevents cross-attempt duplicate writes and only identical full readiness settles intent", async () => {
  const memory = await Effect.runPromise(InMemoryService());
  const run = <A, E>(effect: Effect.Effect<A, E, State>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(State, Effect.succeed(memory))));
  const scope = { name: "fixture", stage: "production" };
  const key = "f".repeat(64);
  const snapshot = readySqlSchemas(identity.candidate);
  const home = snapshot.observations.find((entry) => entry.namespace === "home")!;
  home.expected = ["2"];
  home.applied = ["1"];
  home.pending = ["2"];
  home.status = "pending";
  snapshot.home = undefined;
  const record = async (value: HomeMigrationReceipt) => {
    snapshot.homeMigration = value;
    await run(writeSqlSchemaJournal(memory, scope, key, snapshot));
  };
  let writes = 0;
  const unknown = await prepareHomeSchema({
    identity,
    info,
    admit: () => true,
    record,
    commands: {
      check: async () => pending,
      migrate: async (allocated) => {
        await allocated?.("d".repeat(64));
        writes++;
        throw new HomeSchemaCommandError("command-timeout");
      },
    },
  });
  assert.equal(unknown.receipt.state, "unknown");
  const first = (await run(readSqlSchemaJournal(scope, key)))!;
  assert.equal(first.unresolvedHome!.containerId, "d".repeat(64));
  const retry = await prepareHomeSchema({
    identity,
    info,
    prior: first.unresolvedHome!,
    admit: () => true,
    record,
    commands: {
      check: async () => pending,
      migrate: async () => {
        writes++;
        return migrated;
      },
    },
  });
  assert.equal(retry.receipt.reason, "prior-intent-unsettled");
  assert.equal(writes, 1);
  const still = (await run(readSqlSchemaJournal(scope, key)))!;
  assert.equal(still.unresolvedHome!.intentId, first.unresolvedHome!.intentId);
  const malformed: HomeMigrationReceipt = {
    ...unknown.receipt,
    state: "skipped",
    after: complete,
    expectedIndexes: [],
  };
  await assert.rejects(record(malformed), /prior-intent-unsettled/);
  await assert.rejects(
    record({
      ...unknown.receipt,
      state: "skipped",
      after: complete,
      intentId: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12),
    }),
    /prior-intent-unsettled/,
  );
  const reconciled = await prepareHomeSchema({
    identity,
    info,
    prior: still.unresolvedHome!,
    admit: () => false,
    record,
    commands: {
      check: async () => complete,
      migrate: async () => {
        writes++;
        return migrated;
      },
    },
  });
  assert.equal(reconciled.receipt.state, "skipped");
  assert.equal(writes, 1);
  assert.equal((await run(readSqlSchemaJournal(scope, key)))!.unresolvedHome, null);
});

test("cleanup failures persist their exact CID and block activation before and after native writes", async (context) => {
  const { HomeContainerCleanupError } = await import("./home-schema-container.ts");
  const { assertSqlSchemas } = await import("./sql-schema-contract.ts");
  for (const phase of ["before-check", "migration", "after-check"] as const) {
    await context.test(phase, async () => {
      const memory = await Effect.runPromise(InMemoryService());
      const run = <A, E>(effect: Effect.Effect<A, E, State>) =>
        Effect.runPromise(effect.pipe(Effect.provideService(State, Effect.succeed(memory))));
      const scope = { name: `cleanup-${phase}`, stage: "production" };
      const key = "f".repeat(64);
      const records: HomeMigrationReceipt[] = [];
      const migrationId = "d".repeat(64);
      const checkId = "e".repeat(64);
      const failedId = phase === "migration" ? migrationId : checkId;
      const snapshot = readySqlSchemas(identity.candidate);
      const home = snapshot.observations.find((entry) => entry.namespace === "home")!;
      home.expected = [String(info.target_version)];
      home.applied = [String(info.target_version)];
      snapshot.home = undefined;
      let checks = 0;
      let writes = 0;
      let admissions = 0;
      const result = await prepareHomeSchema({
        identity,
        info,
        admit: () => {
          admissions++;
          return true;
        },
        record: async (receipt) => {
          records.push(receipt);
          snapshot.homeMigration = receipt;
          await run(writeSqlSchemaJournal(memory, scope, key, snapshot));
        },
        commands: {
          check: async () => {
            checks++;
            if (
              (phase === "before-check" && checks === 1) ||
              (phase === "after-check" && checks === 2)
            )
              throw new HomeContainerCleanupError(checkId);
            return checks === 1 ? pending : complete;
          },
          migrate: async (allocated) => {
            await allocated?.(migrationId);
            assert.equal(records.at(-1)!.containerId, migrationId);
            writes++;
            if (phase === "migration") throw new HomeContainerCleanupError(migrationId);
            return migrated;
          },
        },
      });
      assert.equal(result.receipt.state, "unknown");
      assert.equal(result.receipt.reason, "cleanup-failed");
      assert.equal(result.receipt.containerId, failedId);
      assert.equal(result.proof.status, "unreadable");
      assert.equal(records.at(-1)!.state, "unknown");
      assert.equal(records.at(-1)!.reason, "cleanup-failed");
      assert.equal(records.at(-1)!.containerId, failedId);
      assert.equal(checks, phase === "before-check" ? 1 : 2);
      assert.equal(writes, phase === "before-check" ? 0 : 1);
      assert.equal(admissions, phase === "before-check" ? 0 : 1);
      assert.deepEqual(
        records.map((receipt) => receipt.state),
        phase === "before-check" ? ["unknown"] : ["intent", "intent", "unknown"],
      );
      if (phase === "migration") {
        assert.deepEqual(result.receipt.after, complete);
        assert.ok(result.receipt.intentId);
      } else {
        assert.equal(result.receipt.after, null);
      }
      snapshot.home = result.proof;
      snapshot.homeMigration = result.receipt;
      await run(writeSqlSchemaJournal(memory, scope, key, snapshot));
      const journal = (await run(readSqlSchemaJournal(scope, key)))!;
      assert.equal(journal.receipt.homeMigration!.containerId, failedId);
      assert.equal(journal.receipt.homeMigration!.reason, "cleanup-failed");
      assert.equal(journal.unresolvedHome!.state, "unknown");
      assert.equal(journal.unresolvedHome!.containerId, failedId);
      assert.equal(journal.unresolvedHome!.reason, "cleanup-failed");
      assert.equal(journal.unresolvedHome!.intentId, result.receipt.intentId);
      assert.throws(
        () => assertSqlSchemas(journal.receipt, identity.candidate),
        /home.*migration=unknown cause=cleanup-failed/,
      );
    });
  }
});
