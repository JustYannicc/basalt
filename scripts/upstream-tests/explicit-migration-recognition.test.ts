import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { migrateProductSteps } from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";

const steps = {
  "20_account_changes": Effect.die("A committed migration must not replay"),
  "21_change_journal_prepare": Effect.die("A committed preparation must not replay"),
};
const startup = migrateProductSteps("private_hosted_migrations", steps, [
  "22_change_journal_activate",
]);
const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`select migration_id, name, created_at::text from private_hosted_migrations order by migration_id`;
});
const fixture = (work: Effect.Effect<void, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`create table private_hosted_migrations (
        migration_id integer primary key,
        name text not null,
        created_at timestamptz not null default now()
      )`;
      yield* sql`insert into private_hosted_migrations (migration_id, name) values
        (20, 'account_changes'), (21, 'change_journal_prepare')`;
      yield* work;
    }).pipe(Effect.provide(pgliteLayer())),
  );

for (const activated of [false, true])
  test(`startup preserves the ${activated ? "activated" : "prepared"} journal without activating or replaying`, () =>
    fixture(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (activated)
          yield* sql`insert into private_hosted_migrations (migration_id, name)
            values (22, 'change_journal_activate')`;
        const before = yield* rows;
        yield* startup;
        yield* startup;
        assert.deepEqual(yield* rows, before);
        assert.deepEqual(
          yield* sql`select to_regprocedure('hosted_change_revision(text,text,text)') is null as absent`,
          [{ absent: true }],
          "Startup must not install the activation function",
        );
      }),
    ));

for (const [name, statement, issue] of [
  [
    "unknown",
    "insert into private_hosted_migrations (migration_id, name) values (23, 'unknown_operation')",
    "23_unknown_operation observed; expected no operation at this ID",
  ],
  [
    "changed activation",
    "insert into private_hosted_migrations (migration_id, name) values (22, 'unexpected_activation')",
    "22_unexpected_activation observed; expected 22_change_journal_activate",
  ],
  [
    "activation before preparation",
    "delete from private_hosted_migrations where migration_id = 21",
    "missing 21_change_journal_prepare below recorded maximum 22",
  ],
  [
    "earlier hole",
    "delete from private_hosted_migrations where migration_id = 20",
    "missing 20_account_changes below recorded maximum 22",
  ],
] as const)
  test(`startup refuses ${name} history without changing its journal`, () =>
    fixture(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (name === "activation before preparation" || name === "earlier hole")
          yield* sql`insert into private_hosted_migrations (migration_id, name)
            values (22, 'change_journal_activate')`;
        yield* sql.unsafe(statement);
        const before = yield* rows;
        const result = yield* startup.pipe(Effect.result);
        assert.ok(Result.isFailure(result));
        assert.ok(result.failure instanceof Error);
        assert.ok(result.failure.message.includes(issue), result.failure.message);
        assert.deepEqual(yield* rows, before);
      }),
    ));
