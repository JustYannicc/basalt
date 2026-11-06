import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import pg from "pg";

// Production's runtime role reads and writes every table but may not create one; the migration
// role owns the schema. A real Postgres with both roles shows a counted call landing.
const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL;
const local =
  adminUrl !== undefined && ["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname);
const require = createRequire(
  new URL("../../.upstream/apps/hosted/cloud/package.json", import.meta.url),
);
const { PgClient } = (await import(
  require.resolve("@effect/sql-pg")
)) as typeof import("@effect/sql-pg");
const sdk = (await import(
  new URL("../../.upstream/packages/sdk/src/core.ts", import.meta.url).href
)) as typeof import("../../.upstream/packages/sdk/src/core.ts");

const database = `tool_call_traffic_${randomBytes(4).toString("hex")}`;
const runtime = `tool_call_runtime_${randomBytes(4).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const url = (user?: string) => {
  const target = new URL(adminUrl!);
  target.pathname = `/${database}`;
  if (user !== undefined) {
    target.username = user;
    target.password = password;
  }
  return target.toString();
};
const withDatabase = <A, E>(
  at: string,
  effect: Effect.Effect<A, E, import("effect/sql").SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(at), maxConnections: 1 })),
      Effect.scoped,
    ),
  );

test(
  "a runtime role that may not create tables still counts a call",
  { skip: !local },
  async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.query(`create role ${runtime} login password '${password}'`);
    await admin.query(`grant pg_read_all_data, pg_write_all_data to ${runtime}`);
    try {
      // The migration job, as the database owner.
      await withDatabase(
        url(),
        Effect.gen(function* () {
          yield* (yield* sdk.makeExecutorStorage({ provider: "postgresql" })).migrate;
        }),
      );
      const owner = new pg.Client({ connectionString: url() });
      await owner.connect();
      const [{ create }] = (
        await owner.query<{ create: boolean }>(
          `select has_schema_privilege('${runtime}', 'public', 'CREATE') as create`,
        )
      ).rows;
      await owner.end();
      assert.equal(create, false, "the runtime role is production's: it may not create tables");
      // The runtime, as the role the deployed Worker logs in as.
      const account = sdk.AccountId.make("acc_runtime");
      const at = Date.parse("2026-11-06T08:10:00Z");
      const counted = await withDatabase(
        url(runtime),
        Effect.gen(function* () {
          const storage = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
          yield* storage.accountTraffic.record({ accounts: [account], at, ok: true });
          return yield* storage.accountTraffic.read({ accounts: [account], from: at - 3_600_000 });
        }),
      );
      assert.deepEqual(
        counted.map((entry) => ({ account: entry.account, requests: entry.hours[0]?.requests })),
        [{ account, requests: 1 }],
      );
    } finally {
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.query(`drop role if exists ${runtime}`);
      await admin.end();
    }
  },
);
