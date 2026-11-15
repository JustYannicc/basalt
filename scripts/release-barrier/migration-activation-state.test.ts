import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { migrationActivationIntent } from "./migration-activation.ts";
import type { MigrationActivationReceipt } from "./migration-activation-contract.ts";
import {
  assertMigrationActivationSettled,
  migrationActivationJournal,
} from "./migration-activation-state.ts";
import {
  readMigrationJournalDatabase,
  type JournalFunction,
} from "./migration-activation-database.ts";
import { releaseOperationFingerprint } from "./release-operation.ts";
import type { SqlJournalSource } from "./sql-schema-read.ts";

const candidate = "a".repeat(40);
const key = "b".repeat(64);
const stack = { name: "fixture", stage: "production" };
function receipt(): MigrationActivationReceipt {
  const intent = migrationActivationIntent(candidate, {
    candidate,
    sourceFingerprint: key,
    readers: {
      release: { candidate, deploymentId: 42, receiptDigest: key },
      workers: (["Api", "AppPages", "PoolWorker"] as const).map((role) => ({
        role,
        target: key,
        versionId: role,
        acceptedVersionId: role,
        percentage: 100,
      })),
      poolAdoption: { candidate, poolWorkerRevision: key, imageInput: key },
      apps: { count: 0, fingerprint: key },
    },
    hosted: { prepared: true, active: false, fingerprint: key },
    pool: { prepared: true, active: false, schemaHash: key, catalogHash: key, report: {} },
  });
  return {
    candidate,
    fingerprint: releaseOperationFingerprint(candidate, intent),
    intent,
    status: "pending",
    sent: true,
  };
}

test("the encrypted global journal blocks later candidates until the recorded operation completes", async () => {
  const store = await Effect.runPromise(InMemoryService());
  const journal = migrationActivationJournal(store, stack, candidate, key);
  assert.equal(await journal.load(), undefined);
  await Effect.runPromise(assertMigrationActivationSettled(store, stack, key));
  const pending = receipt();
  await journal.save(pending);
  assert.deepEqual(await journal.load(), pending);
  const wire = await Effect.runPromise(
    store.getOutput({ stack: "fixture-migration-activation", stage: "production" }),
  );
  assert.equal(JSON.stringify(wire).includes("poolWorkerRevision"), false);
  await assert.rejects(
    Effect.runPromise(assertMigrationActivationSettled(store, stack, key)),
    /migration-activation-pending/,
  );
  const later = migrationActivationJournal(store, stack, "c".repeat(40), key);
  await assert.rejects(later.load(), /migration-activation-pending/);
  const complete: MigrationActivationReceipt = {
    ...pending,
    status: "complete",
    result: { hosted: "active", pool: "active" },
  };
  await journal.save(complete);
  await Effect.runPromise(assertMigrationActivationSettled(store, stack, key));
  assert.equal(await later.load(), undefined);
  await assert.rejects(journal.save(pending), /migration-activation-journal-overwrite/);
});

test("a different plan cannot replace a pending receipt, and a wrong key cannot clear the guard", async () => {
  const store = await Effect.runPromise(InMemoryService());
  const journal = migrationActivationJournal(store, stack, candidate, key);
  const pending = receipt();
  await journal.save(pending);
  const changed = {
    ...pending.intent,
    before: { ...pending.intent.before, sourceFingerprint: "c".repeat(64) },
  };
  await assert.rejects(
    journal.save({
      ...pending,
      intent: changed,
      fingerprint: releaseOperationFingerprint(candidate, changed),
    }),
    /journal-overwrite/,
  );
  await assert.rejects(
    Effect.runPromise(assertMigrationActivationSettled(store, stack, "d".repeat(64))),
    /journal-unreadable/,
  );
  assert.deepEqual(await journal.load(), pending);
});

function sqlFixture(active: boolean) {
  const prepared: JournalFunction = {
    name: "hosted_project_changes",
    args: "integer",
    result: "integer",
    language: "plpgsql",
    body: "BEGIN RETURN 1; END",
    volatility: "v",
  };
  const flush: JournalFunction = {
    name: "hosted_flush_changes",
    args: "",
    result: "trigger",
    language: "plpgsql",
    body: "BEGIN RETURN NULL; END",
    volatility: "v",
  };
  const old = { ...flush, body: "BEGIN RETURN NEW; END" };
  const rows: Record<string, unknown>[] = [prepared, active ? flush : old].map((fn) => ({
    ...fn,
    security_definer: false,
    config: null,
  }));
  const trigger = [
    {
      name: "hosted_flush_changes",
      type: 5,
      enabled: "O",
      deferrable: true,
      deferred: true,
      function: "hosted_flush_changes",
      function_schema: "public",
      internal: false,
      condition: null,
      arguments: "",
    },
  ];
  const calls: string[] = [];
  const source: SqlJournalSource = {
    databaseName: "fixture",
    connect: async () => ({
      query: async (text) => {
        calls.push(text);
        if (text.includes("current_database"))
          return { rows: [{ database_matches: true, schema_matches: true, read_only: true }] };
        if (text.includes("private_hosted_migrations"))
          return {
            rows: [
              { migration_id: 21, name: "change_journal_prepare" },
              ...(active ? [{ migration_id: 22, name: "change_journal_activate" }] : []),
            ],
          };
        if (text.includes("FROM pg_proc")) return { rows };
        if (text.includes("FROM pg_trigger")) return { rows: trigger };
        return { rows: [] };
      },
      end: async () => {
        calls.push("end");
      },
    }),
  };
  return {
    options: {
      source,
      kind: "hosted" as const,
      prepared: [prepared],
      active: [flush],
      inactive: [old],
    },
    rows,
    trigger,
    calls,
  };
}

test("SQL inspection proves the preparation and queue function in an explicit read-only transaction", async () => {
  for (const active of [false, true]) {
    const f = sqlFixture(active);
    const observed = await readMigrationJournalDatabase(f.options);
    assert.equal(observed.prepared, true);
    assert.equal(observed.active, active);
    assert.equal(f.calls[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.deepEqual(f.calls.slice(-2), ["COMMIT", "end"]);
    assert.equal(
      f.calls.some((text) => /^(?:INSERT|UPDATE|CREATE|ALTER|DELETE)\b/u.test(text)),
      false,
    );
  }
});

test("an active marker cannot establish success with a changed function or an immediate trigger", async () => {
  const changed = sqlFixture(true);
  changed.rows[1]!.body = "BEGIN RAISE EXCEPTION 'different'; END";
  assert.equal((await readMigrationJournalDatabase(changed.options)).active, false);
  const immediate = sqlFixture(true);
  immediate.trigger[0]!.deferred = false;
  assert.equal((await readMigrationJournalDatabase(immediate.options)).active, false);
});
