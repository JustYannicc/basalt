import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Result } from "effect";
import { SqlClient } from "effect/sql";
import { fixture } from "./account-change-fixture.ts";
import { migrateProductSteps } from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";
import { prepareChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-journal-schema.ts";
import { selfHostChangeJournalCutover } from "../../.upstream/apps/hosted/self-host/src/implementation/change-journal-cutover.ts";

const cutover = (configuration: Record<string, string>) =>
  selfHostChangeJournalCutover.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(configuration)),
  );
const acknowledged = { EXECUTOR_CHANGE_JOURNAL_READERS_READY: "checkpoint-count-v1" };

test("self-host startup keeps legacy producers unless the exact reader contract is acknowledged", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* cutover({});
      yield* sql`update executor_accounts set label='Legacy still active' where id='acc_a'`;
      assert.deepEqual(yield* sql`select count(*)::int as n from hosted_change_batches`, [
        { n: 0 },
      ]);
      const invalid = yield* cutover({
        EXECUTOR_CHANGE_JOURNAL_READERS_READY: "older-reader",
      }).pipe(Effect.result);
      assert.ok(Result.isFailure(invalid));
      assert.deepEqual(
        yield* sql`select to_regprocedure('hosted_change_revision(text,text,text)') is null as absent`,
        [{ absent: true }],
      );
    }),
  ));

test("self-host activation requires an earlier committed prepare and never skips later normal preparation", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrateProductSteps("private_hosted_migrations", {
        "20_account_changes": Effect.void,
      });
      const missing = yield* cutover(acknowledged).pipe(Effect.result);
      assert.ok(Result.isFailure(missing));
      assert.match(missing.failure.message, /missing 21_change_journal_prepare/);
      const preparation = migrateProductSteps("private_hosted_migrations", {
        "20_account_changes": Effect.die("committed account migration must not run again"),
        "21_change_journal_prepare": prepareChangeJournal,
      });
      yield* preparation;
      yield* cutover({});
      assert.deepEqual(
        yield* sql`select migration_id from private_hosted_migrations order by migration_id`,
        [{ migration_id: 20 }, { migration_id: 21 }],
      );
      yield* cutover(acknowledged);
      yield* cutover(acknowledged);
      assert.deepEqual(
        yield* sql`select migration_id from private_hosted_migrations order by migration_id`,
        [{ migration_id: 20 }, { migration_id: 21 }, { migration_id: 22 }],
      );
      yield* sql`select hosted_queue_change('organization:team-a','accounts','*')`;
      assert.deepEqual(yield* sql`select count(*)::int as n from hosted_change_batches`, [
        { n: 1 },
      ]);
      assert.deepEqual(yield* sql`select * from hosted_change_heads`, []);
      assert.deepEqual(
        yield* sql`select hosted_change_revision('organization:team-a','accounts','*')::text as revision`,
        [{ revision: "1" }],
      );
      yield* migrateProductSteps("private_hosted_migrations", {
        "20_account_changes": Effect.die("committed account migration must not run again"),
        "21_change_journal_prepare": Effect.die("committed preparation must not run again"),
        "22_change_journal_activate": Effect.die("committed activation must not run again"),
        "23_later_preparation": Effect.void,
      });
      assert.deepEqual(
        yield* sql`select migration_id from private_hosted_migrations order by migration_id`,
        [{ migration_id: 20 }, { migration_id: 21 }, { migration_id: 22 }, { migration_id: 23 }],
      );
    }),
  ));
