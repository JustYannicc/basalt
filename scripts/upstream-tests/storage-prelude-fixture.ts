import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { storageSchemas } from "../../.upstream/packages/sdk/src/implementation/storage-migrations.ts";
import { aesGcmCredentials } from "../../.upstream/packages/sdk/src/implementation/credentials.ts";
import { AccountId } from "../../.upstream/packages/sdk/src/contracts/shared.ts";
import { AppCallReceiptId } from "../../.upstream/packages/sdk/src/contracts/app-calls.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const {
  PgliteClient,
}: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pglite/dist/PgliteClient.js") =
  await import(require.resolve("@effect/sql-pglite/PgliteClient"));

export const preludeVersion = "4.0.29";
export const historicalSchemas = storageSchemas.filter((entry) => entry.version !== preludeVersion);
export const historicalDatabase = fumadb({ namespace: "executor", schemas: historicalSchemas });
export const queueNames = [
  "executor_webhook_sources_intent",
  "executor_webhook_sources_retry",
  "executor_account_checks_account_app",
] as const;

export const inPglite = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | SqlClient.SqlClient
    | import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pglite/dist/PgliteClient.js").PgliteClient
  >,
  snapshot?: Blob,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(pgliteLayer(snapshot ? { loadDataDir: snapshot } : {}))),
  );

export const archive = Effect.gen(function* () {
  const pg = (yield* PgliteClient).pglite;
  return yield* Effect.promise(() => pg.dumpDataDir());
});

/** Create an actual historical layout; never label current tables with an older version. */
export const historicalLayout = (version: string) =>
  Effect.gen(function* () {
    assert.ok(
      historicalSchemas.some((entry) => entry.version === version),
      version,
    );
    const migrator = yield* historicalDatabase.client(sqlAdapter({ provider: "postgresql" }))
      .createMigrator;
    yield* (yield* migrator.migrateTo(historicalSchemas[0]!.version)).execute;
    for (const entry of historicalSchemas.slice(1)) {
      if (Number(entry.version.split(".")[2]) > Number(version.split(".")[2])) break;
      yield* (yield* migrator.up()).execute;
    }
    yield* seedRetained(version);
  });

const retainedTables = [
  "executor_providers",
  "executor_accounts",
  "executor_apps",
  "executor_app_records",
  "executor_oauth_grants",
  "executor_app_connections",
  "executor_app_call_receipts",
  "executor_account_targets",
  "executor_webhook_sources",
  "executor_account_checks",
] as const;

const identifier = (name: string) => {
  assert.match(name, /^[a-z_]+$/);
  return `"${name}"`;
};

const fixtureCredentials = aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
const fixtureFields = { token: "synthetic-storage-prelude-only" };
const fixtureAccount = AccountId.make("acc_storageprelude");
const fixtureReceipt = AppCallReceiptId.make("receipt_storageprelude");
const fixtureReceiptFields = {
  fingerprint: "fixture-fingerprint",
  dispatch: "00000000-0000-4000-8000-000000000001",
};

/** Project the same columns after upgrade, so added nullable fields do not mask data loss. */
export const retained = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const snapshots = [];
  for (const table of retainedTables) {
    const columns = yield* sql<{ column_name: string }>`select column_name
      from information_schema.columns where table_schema = current_schema()
      and table_name = ${table} order by ordinal_position`;
    if (columns.length === 0) continue;
    const query = `select ${columns.map((column) => identifier(column.column_name)).join(", ")}
      from ${identifier(table)} order by 1`;
    snapshots.push({ table, query, rows: yield* sql.unsafe(query) });
  }
  return snapshots;
});

export const assertRetained = (before: Effect.Success<typeof retained>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const snapshot of before)
      assert.deepEqual(yield* sql.unsafe(snapshot.query), snapshot.rows, snapshot.table);
    const [account] = yield* sql<{ encrypted_credentials: Uint8Array }>`select encrypted_credentials
      from executor_accounts where id = 'acc_storageprelude'`;
    assert.ok(account);
    const credentials = yield* fixtureCredentials;
    const fields = yield* credentials.decrypt(
      fixtureAccount,
      Redacted.make(account.encrypted_credentials),
    );
    assert.deepEqual(Redacted.value(fields), fixtureFields);
    if (before.some((snapshot) => snapshot.table === "executor_app_call_receipts")) {
      const [receipt] = yield* sql<{ encrypted: Uint8Array }>`select encrypted
        from executor_app_call_receipts where id = 'receipt_storageprelude'`;
      assert.ok(receipt);
      const payload = yield* credentials.decrypt(fixtureReceipt, Redacted.make(receipt.encrypted));
      assert.deepEqual(Redacted.value(payload), fixtureReceiptFields);
    }
  });

export const queueIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    name: string;
    oid: number;
    definition: string;
    predicate: string | null;
    valid: boolean;
    ready: boolean;
  }>`select c.relname as name, c.oid::int as oid, pg_get_indexdef(c.oid) as definition,
      pg_get_expr(i.indpred, i.indrelid) as predicate, i.indisvalid as valid, i.indisready as ready
    from pg_class c join pg_index i on i.indexrelid = c.oid
      join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and c.relname in ${sql.in(queueNames)} order by c.relname`;
});

export const assertQueueIndexes = Effect.gen(function* () {
  const indexes = yield* queueIndexes;
  assert.deepEqual(
    indexes.map((row) => row.name),
    [...queueNames].sort(),
  );
  assert.ok(indexes.every((row) => row.valid && row.ready));
  const intent = indexes.find((row) => row.name === queueNames[0])!;
  const retry = indexes.find((row) => row.name === queueNames[1])!;
  const account = indexes.find((row) => row.name === queueNames[2])!;
  assert.match(intent.definition, /executor_webhook_sources.*\(lease_until\)/);
  assert.match(intent.predicate!, /status.*pending/);
  assert.match(intent.predicate!, /lease IS NULL/i);
  assert.match(retry.definition, /executor_webhook_sources.*\(lease_until\)/);
  assert.match(retry.predicate!, /status.*<>.*ready/);
  assert.match(account.definition, /executor_account_checks.*\(account, app\)/);
  assert.equal(account.predicate, null);
  return indexes;
});

const seedRetained = (version: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const revision = Number(version.split(".")[2]);
    const credentials = yield* fixtureCredentials;
    const encrypted = yield* credentials.encrypt(fixtureAccount, Redacted.make(fixtureFields));
    const credentialHex = Buffer.from(encrypted).toString("hex");
    yield* sql`insert into executor_providers (id, definition)
      values ('prv_storageprelude', '{"fixture":true}')`;
    yield* sql`insert into executor_accounts
      (id, owner, provider, method, label, encrypted_credentials, created_at)
      values ('acc_storageprelude', 'fixture-owner', 'prv_storageprelude', 'token', 'Retained',
        decode(${credentialHex}, 'hex'), '2026-01-01T00:00:00Z')`;
    if (revision >= 2)
      yield* sql`update executor_accounts set credential_generation = 7 where id = 'acc_storageprelude'`;
    if (revision >= 16)
      yield* sql`update executor_accounts set site = 'https://retained.invalid' where id = 'acc_storageprelude'`;
    yield* sql`insert into executor_apps (id, code, owner, name, slug, created_at)
      values ('app_storageprelude', 'code_storageprelude', 'fixture-owner', 'Retained', 'retained',
        '2026-01-01T00:00:00Z')`;
    yield* sql`insert into executor_app_records (id, app, table_name, record_key, value)
      values ('record_storageprelude', 'app_storageprelude', 'retained', 'one', '{"retained":true}')`;
    yield* sql`insert into executor_oauth_grants (id, encrypted, status, updated_at)
      values ('grant_storageprelude', decode('06070809', 'hex'), 'active', '2026-01-01T00:00:00Z')`;
    if (revision >= 27) {
      const receipt = yield* credentials.encrypt(
        fixtureReceipt,
        Redacted.make(fixtureReceiptFields),
      );
      const receiptHex = Buffer.from(receipt).toString("hex");
      yield* sql`insert into executor_app_connections
        (id, app, owner, dependency, subject, target, authorizer, revision, enabled, encrypted,
          created_at, updated_at)
        values ('connection_storageprelude', 'app_storageprelude', 'fixture-owner', 'retained',
          'fixture-person', 'app_storageprelude', 'fixture-authorizer', 3, true,
          decode('101112', 'hex'), '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`;
      yield* sql`insert into executor_app_call_receipts
        (id, app, owner, connection, state, deadline, encrypted, created_at, updated_at)
        values ('receipt_storageprelude', 'app_storageprelude', 'fixture-owner',
          'connection_storageprelude', 'reserved', '2099-01-01T00:00:00Z', decode(${receiptHex}, 'hex'),
          '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`;
    }
    if (revision >= 28)
      yield* sql`insert into executor_account_targets
        (account, owner, revision, mode, enabled, device, device_name, binding, manifest_revision)
        values ('acc_storageprelude', 'fixture-owner', 5, 'device', true, 'fixture-device',
          'Retained device', 'fixture-binding', 'fixture-manifest')`;
    if (revision >= 13) {
      yield* sql`insert into executor_webhook_sources
        (id, app, owner, account, actor, accounts, config, revision, status, failure,
          reconciled_deployment, lease, lease_until, created_at)
        select 'source_' || n, 'app_' || n, 'fixture-owner', 'acc_storageprelude',
          'fixture-person', '{}', '{}', 1,
          case when n % 4 = 0 then 'pending' when n % 4 = 1 then 'failed' else 'ready' end,
          null, null, null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        from generate_series(1, 64) n`;
    }
    if (revision >= 3)
      yield* sql`insert into executor_account_checks
        (id, account, app, deployment, credential_generation, status, checked_at)
        values ('check_storageprelude', 'acc_storageprelude', 'app_storageprelude',
          'version_storageprelude', 7, 'ready', '2026-01-01T00:00:00Z')`;
  });
