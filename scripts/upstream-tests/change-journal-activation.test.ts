import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Effect, Redacted, Result } from "effect";
import {
  activateHostedChangeJournal,
  migrateProductSteps,
} from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";
import { prepareChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-journal-schema.ts";
import { localPostgres, postgresChanges } from "./account-change-postgres-fixture.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const PgClient: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pg/dist/PgClient.js") =
  await import(require.resolve("@effect/sql-pg/PgClient"));

test(
  "Hosted preparation preserves legacy producers; activation requires a committed preparation and records its exact ID once",
  { skip: !localPostgres },
  async () => {
    await postgresChanges(async ({ a, observer }) => {
      const schema = String(
        (await observer.query("select current_schema() as schema")).rows[0].schema,
      );
      const run = <A, E>(work: Effect.Effect<A, E, import("effect/sql/SqlClient").SqlClient>) =>
        Effect.runPromise(
          work.pipe(
            Effect.provide(
              PgClient.layer({
                url: Redacted.make(process.env.POOL_TEST_ADMIN_URL!),
                maxConnections: 1,
                startupParameters: { search_path: schema },
              }),
            ),
          ),
        );
      await run(
        migrateProductSteps("private_hosted_migrations", { "20_account_changes": Effect.void }),
      );
      const refusal = await run(activateHostedChangeJournal.pipe(Effect.result));
      assert.ok(Result.isFailure(refusal));
      assert.match(
        refusal.failure.message,
        /private_hosted_migrations is missing 21_change_journal_prepare/,
      );
      assert.equal(
        (
          await a.query(
            "select count(*)::int as n from private_hosted_migrations where migration_id=22",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await a.query(
            "select to_regprocedure('hosted_change_revision(text,text,text)') is null as absent",
          )
        ).rows[0].absent,
        true,
      );

      const prepare = migrateProductSteps("private_hosted_migrations", {
        "21_change_journal_prepare": prepareChangeJournal,
      });
      await run(prepare);
      await run(prepare);
      await a.query("update executor_accounts set label='Legacy still serves' where id='acc_a'");
      const before = String(
        (
          await a.query(
            "select revision from hosted_change_heads where scope='organization:team-a' and topic='accounts' and resource='*'",
          )
        ).rows[0].revision,
      );
      assert.equal(
        (await a.query("select count(*)::int as n from hosted_change_dirty")).rows[0].n,
        0,
      );
      assert.equal(
        (
          await a.query(
            "select count(*)::int as n from private_hosted_migrations where migration_id=22",
          )
        ).rows[0].n,
        0,
      );

      await a.query(
        "insert into private_hosted_migrations(migration_id,name) values(23,'later_preparation')",
      );
      await run(activateHostedChangeJournal);
      await run(activateHostedChangeJournal);
      assert.deepEqual(
        (await a.query("select migration_id from private_hosted_migrations order by migration_id"))
          .rows,
        [20, 21, 22, 23].map((migration_id) => ({ migration_id })),
      );
      await a.query("update executor_accounts set label='Queue producer' where id='acc_a'");
      assert.equal(
        String(
          (
            await a.query(
              "select revision from hosted_change_heads where scope='organization:team-a' and topic='accounts' and resource='*'",
            )
          ).rows[0].revision,
        ),
        before,
      );
      assert.equal(
        String(
          (
            await a.query(
              "select hosted_change_revision('organization:team-a','accounts','*') as revision",
            )
          ).rows[0].revision,
        ),
        String(BigInt(before) + 1n),
      );
    });
  },
);
