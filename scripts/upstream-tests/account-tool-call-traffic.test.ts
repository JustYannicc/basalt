import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Logger, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";

// The runtime database role may not create tables, so the storage migration, run by the
// migration role, creates the counts table and the runtime only writes to it.
const sdk = (await import(
  new URL("../../.upstream/packages/sdk/src/core.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/sdk/src/core.ts");
const ops = (await import(
  new URL(
    "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/inventory.ts",
    import.meta.url,
  ).href
)) as typeof import("../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/inventory.ts");

const organization = "org_counted";
const account = "acc_counted";
const counted = sdk.AccountId.make(account);
const foreign = sdk.AccountId.make("acc_foreign");

/** Executor storage migrated on a fresh PGlite, with one saved account, and the logs written. */
const migrated = <A>(
  run: (
    storage: Effect.Success<ReturnType<typeof sdk.makeExecutorStorage>>,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) => {
  const logs: { message: unknown; level: string; annotations: Record<string, unknown> }[] = [];
  const capture = Logger.make((options) => {
    const { message, level, annotations } = Logger.formatStructured.log(options);
    logs.push({ message, level, annotations });
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const storage = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      yield* sql`insert into executor_providers (id, definition) values ('prv_counted', ${JSON.stringify({ name: "Counted" })})`;
      yield* sql`insert into executor_accounts (id, owner, provider, method, label, encrypted_credentials, created_at)
        values (${account}, ${`organization:${organization}`}, 'prv_counted', 'key', 'Counted key', ${new Uint8Array([1])}, now())`;
      return yield* run(storage, sql);
    }).pipe(Effect.provide(pgliteLayer()), Effect.provide(Logger.layer([capture])), Effect.scoped),
  ).then((value) => ({ value, logs }));
};

test("the storage migration creates the counts table and a counted call only writes", async () => {
  const { value } = await migrated((storage, sql) =>
    Effect.gen(function* () {
      const [table] = yield* sql<{ exists: boolean }>`
        select to_regclass('executor_account_tool_calls') is not null as exists`;
      const at = Date.now();
      yield* storage.accountTraffic.record({ accounts: [counted], at, ok: true });
      const read = yield* storage.accountTraffic.read({
        accounts: [counted],
        from: at - 3_600_000,
      });
      return {
        table: table?.exists,
        requests: read[0]?.hours.reduce((sum, hour) => sum + hour.requests, 0),
      };
    }),
  );
  assert.deepEqual(value, { table: true, requests: 1 });
});

test("a count the runtime cannot save fails visibly with its SQLSTATE instead of creating a table", async () => {
  const { value, logs } = await migrated((storage, sql) =>
    Effect.gen(function* () {
      yield* sql`drop table executor_account_tool_calls`;
      const recorded = yield* storage.accountTraffic
        .record({ accounts: [counted], at: Date.now(), ok: true })
        .pipe(Effect.result);
      const [table] = yield* sql<{ exists: boolean }>`
        select to_regclass('executor_account_tool_calls') is not null as exists`;
      return { failed: recorded._tag === "Failure", recreated: table?.exists };
    }),
  );
  assert.deepEqual(value, { failed: true, recreated: false });
  assert.deepEqual(
    logs
      .filter((log) => JSON.stringify(log.message).includes("Account tool calls were not counted"))
      .map((log) => log.annotations),
    [
      {
        "executor.account_traffic.failure": "storage",
        "executor.account_traffic.sqlstate": "42P01",
      },
    ],
  );
});

test("the tool-call-traffic inventory lists one organization's accounts with their counts only", async () => {
  const { value } = await migrated((storage, sql) =>
    Effect.gen(function* () {
      yield* sql`insert into executor_accounts (id, owner, provider, method, label, encrypted_credentials, created_at)
        values ('acc_foreign', 'organization:org_foreign', 'prv_counted', 'key', 'Foreign key', ${new Uint8Array([1])}, now())`;
      const at = Date.now();
      yield* storage.accountTraffic.record({ accounts: [counted], at, ok: true });
      yield* storage.accountTraffic.record({ accounts: [counted], at, ok: false });
      yield* storage.accountTraffic.record({ accounts: [foreign], at, ok: true });
      return yield* ops.inventory("tool-call-traffic", organization);
    }),
  );
  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        account: Schema.String,
        provider: Schema.String,
        hours: Schema.Number,
        requests: Schema.Number,
        failed: Schema.Number,
        last_hour: Schema.NullOr(Schema.String),
        last_success: Schema.NullOr(Schema.String),
      }),
    ),
  )(value.rows);
  assert.deepEqual(
    rows.map(({ last_hour, last_success, ...counts }) => ({
      ...counts,
      counted: last_hour !== null && last_success !== null,
    })),
    [{ account, provider: "prv_counted", hours: 1, requests: 2, failed: 1, counted: true }],
  );
});
