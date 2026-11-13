import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State, type PersistedState } from "alchemy/State/State";
import { Effect, Redacted, Schema } from "effect";
import { releaseWorkers } from "./barrier.ts";
import { releaseEvidence } from "./evidence.ts";
import { beginForwardJournal, journalKey, readForwardJournal } from "./forward-journal.ts";
import { canonical, digest } from "./manifest.ts";
import { readRecoveryProgress, recoveryReceipt } from "./recovery-manifest.ts";
import { recoverWorkers, type RecoveryReceipt, type RecoveryWorker } from "./recovery.ts";
import { BarrierRefusal } from "./refusal.ts";
import { refusalTable } from "./refusal-report.ts";
import { assertSqlSchemas, type SqlSchemaReceipt } from "./sql-schema-contract.ts";
import { homeMigrationReceiptCodec, sqlSchemaReceiptCodec } from "./sql-schema-codec.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";
import { containerRelease } from "./test/container-fixture.ts";

const key = "f".repeat(64);
const at = "2026-11-12T00:00:00.000Z";
function schemaIntent(candidate: string, imageDigest?: string): SqlSchemaReceipt {
  const receipt = readySqlSchemas(candidate, imageDigest);
  return {
    ...receipt,
    home: {
      imageDigest: receipt.homeImageDigest,
      targetVersion: 16,
      expectedIndexes: ["idx_usage_key_success_time_v1"],
      readyIndexes: null,
      pendingIndexes: null,
      status: "pending",
      observedAt: at,
    },
    observations: receipt.observations.map((entry) =>
      entry.namespace === "home"
        ? { ...entry, expected: ["16"], applied: ["15"], pending: ["16"], status: "pending" }
        : entry,
    ),
    homeMigration: {
      candidate,
      imageDigest: receipt.homeImageDigest,
      imageConfigDigest: `sha256:${"b".repeat(64)}`,
      baselineImageDigest: `sha256:${"c".repeat(64)}`,
      sourceInputHash: "a".repeat(16),
      baselineInputHash: "b".repeat(16),
      targetVersion: 16,
      expectedIndexes: ["idx_usage_key_success_time_v1"],
      state: "intent",
      intentId: "12345678-1234-4234-8234-123456789abc",
      priorIntentId: "22345678-1234-4234-8234-123456789abc",
      containerId: "d".repeat(64),
      before: {
        format_version: 1,
        target_version: 16,
        previous_version: null,
        applied_version: 15,
        status: "pending",
        indexes_checked: false,
        pending_indexes: [],
        reason: "schema_pending",
      },
      after: null,
      at,
    },
  };
}
const decode = Schema.decodeUnknownSync(sqlSchemaReceiptCodec, { onExcessProperty: "error" });

test("strict SQL receipts retain every observation and bounded native Home operation state", () => {
  const receipt = schemaIntent("a".repeat(40));
  assert.deepEqual(decode(receipt), receipt);
  for (const state of [
    "skipped",
    "intent",
    "migrated",
    "noop",
    "refused",
    "failed",
    "unknown",
  ] as const) {
    const operation = { ...receipt.homeMigration!, state };
    assert.deepEqual(
      Schema.decodeUnknownSync(homeMigrationReceiptCodec, { onExcessProperty: "error" })(operation),
      operation,
    );
  }
  assert.equal(
    decode({
      ...receipt,
      homeMigration: { ...receipt.homeMigration, state: "unknown", reason: "cleanup-failed" },
    }).homeMigration?.reason,
    "cleanup-failed",
  );
  for (const invalid of [
    { ...receipt, observations: receipt.observations.slice(1) },
    { ...receipt, observations: receipt.observations.map(() => receipt.observations[0]) },
    { ...receipt, home: { ...receipt.home, driverError: "arbitrary driver text" } },
    { ...receipt, homeMigration: { ...receipt.homeMigration, reason: "arbitrary driver text" } },
    { ...receipt, homeMigration: { ...receipt.homeMigration, sourceInputHash: "not-a-hash" } },
    { ...receipt, homeMigration: { ...receipt.homeMigration, containerId: "not-a-container-id" } },
    {
      ...receipt,
      homeMigration: {
        ...receipt.homeMigration,
        before: { ...receipt.homeMigration!.before, sqlstate: "arbitrary driver text" },
      },
    },
    {
      ...receipt,
      observations: receipt.observations.map((entry) => ({
        ...entry,
        applied: ["not a source version"],
      })),
    },
  ])
    assert.throws(() => decode(invalid));
});

test("actual barrier producer persists schema phase and Home intent through encrypted forward journal", async () => {
  const fixture = containerRelease();
  const schemas = schemaIntent(fixture.manifest.candidate, fixture.frozen.imageDigest);
  const saved: PersistedState = {
    resourceType: "Cloudflare.Container",
    namespace: undefined,
    fqn: "PoolContainer",
    logicalId: "PoolContainer",
    instanceId: "instance",
    providerVersion: 1,
    status: "updated",
    downstream: ["PoolWorker"],
    bindings: [],
    props: { secret: Redacted.make("synthetic-journal-secret") },
    attr: fixture.previous,
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InMemoryService();
      const stack = { name: "fixture", stage: "test" };
      yield* state.set({
        stack: stack.name,
        stage: stack.stage,
        fqn: "PoolContainer",
        value: saved,
      });
      const journal = yield* beginForwardJournal(stack, fixture.manifest, key).pipe(
        Effect.provideService(State, Effect.succeed(state)),
      );
      assert.ok(journal);
      yield* Effect.promise(async () => {
        await assert.rejects(
          releaseWorkers(fixture.manifest, {
            ...fixture.options,
            sqlSchemas: async (record) => {
              await record(schemas);
              return schemas;
            },
            record: (receipt) => Effect.runPromise(journal.record(receipt)),
          }),
          /sql-schema-not-ready/u,
        );
      });
      const stored = yield* state.getOutput(journalKey(stack));
      assert.doesNotMatch(
        JSON.stringify(stored),
        /synthetic-journal-secret|schema_pending|sourceInputHash/u,
      );
      const recovered = yield* readForwardJournal(stack, key).pipe(
        Effect.provideService(State, Effect.succeed(state)),
      );
      assert.ok(recovered && !recovered.complete);
      assert.equal(recovered.packet.receipt.phase, "schema");
      assert.deepEqual(recovered.packet.receipt.sqlSchemas, schemas);
      assert.equal(recovered.packet.receipt.sqlSchemas?.homeMigration?.containerId, "d".repeat(64));
      assert.deepEqual(recovered.packet.receipt.activated, []);
      assert.deepEqual(
        fixture.events.filter((event) => event.startsWith("activate:")),
        [],
      );
    }),
  );
});

test("rollback retains pending SQL intent in recovery output without requiring schema readiness", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sql-codec-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = containerRelease();
  const schemas = schemaIntent(fixture.manifest.candidate, fixture.frozen.imageDigest);
  const receipt = {
    schemaVersion: 2,
    candidate: fixture.manifest.candidate,
    manifest: digest(canonical(fixture.description)),
    accepted: [],
    sqlSchemas: schemas,
  };
  assert.deepEqual(Schema.decodeUnknownSync(recoveryReceipt)(receipt).sqlSchemas, schemas);
  const evidence = releaseEvidence(root, fixture.manifest.candidate);
  const progress: RecoveryReceipt[] = [];
  const provider = {
    async read(worker: RecoveryWorker) {
      return { target: worker.target, versions: worker.baseline };
    },
    async restore() {
      assert.fail("already baseline");
    },
  };
  const record = async (value: RecoveryReceipt) => {
    progress.push(structuredClone(value));
    await evidence.recovery(value);
  };
  await assert.rejects(
    recoverWorkers(
      fixture.description,
      { ...receipt, sqlSchemas: { ...schemas, driverError: "arbitrary driver text" } },
      provider,
      record,
      async () => {},
    ),
  );
  assert.equal(progress.length, 0);
  await recoverWorkers(fixture.description, receipt, provider, record, async () => {});
  const previous = readRecoveryProgress(
    JSON.parse(await readFile(join(root, "recovery.json"), "utf8")),
  );
  assert.deepEqual(previous.sqlSchemas, schemas);
  await recoverWorkers(
    fixture.description,
    { ...receipt, sqlSchemas: undefined },
    provider,
    record,
    async () => {},
    previous,
  );
  assert.ok(progress.length >= 2);
  for (const item of progress) assert.deepEqual(item.sqlSchemas, schemas);
});

test("failure evidence keeps SQL versions and exact native Home refusal in the job table", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sql-codec-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const schemas = schemaIntent("a".repeat(40));
  const failed: SqlSchemaReceipt = {
    ...schemas,
    homeMigration: { ...schemas.homeMigration!, state: "failed", reason: "migration_failed" },
  };
  let refusal: BarrierRefusal | undefined;
  try {
    assertSqlSchemas(failed, failed.candidate);
  } catch (error) {
    assert.ok(error instanceof BarrierRefusal);
    refusal = error;
  }
  assert.ok(refusal);
  const evidence = releaseEvidence(root, failed.candidate);
  await evidence.record({
    schemaVersion: 1,
    candidate: failed.candidate,
    manifest: "fixture",
    phase: "schema",
    ceilingMs: 750,
    accepted: [],
    activated: [],
    sqlSchemas: failed,
  });
  const failure = await evidence.failure(refusal);
  assert.deepEqual(failure.sqlSchemas, failed);
  const retained = JSON.parse(await readFile(join(root, "failure.json"), "utf8"));
  assert.deepEqual(retained.sqlSchemas, failed);
  const table = refusalTable(retained);
  assert.match(table, /SQL.home/u);
  assert.match(table, /15.*16/u);
  assert.match(table, /migration_failed/u);
});
