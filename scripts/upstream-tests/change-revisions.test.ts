import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { migrateProductSteps } from "../../.upstream/apps/hosted/server/src/implementation/migrations.ts";

const key = { topic: "deployment", resource: "app-a" };
test("migration 19 preserves retained apps, runs once and leaves existing SQL writers usable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`create table executor_apps (id text primary key, owner text not null, active_deployment text)`;
      yield* sql`insert into executor_apps values ('app-a', 'organization:team-a', 'retained-build')`;
      yield* migrateProductSteps("private_hosted_migrations", {
        "18_tool_availability": Effect.void,
      });
      const upgrade = migrateProductSteps("private_hosted_migrations", {
        "19_change_revisions": migrateChangeRevisions,
      });
      yield* upgrade;
      yield* upgrade;
      assert.deepEqual(yield* sql`select active_deployment from executor_apps`, [
        { active_deployment: "retained-build" },
      ]);
      assert.deepEqual(
        yield* sql`select migration_id from private_hosted_migrations order by migration_id`,
        [{ migration_id: 18 }, { migration_id: 19 }],
      );
      // The running, older server can still activate without knowing about the outbox.
      yield* sql`update executor_apps set active_deployment = 'next-build' where id = 'app-a'`;
      assert.deepEqual(yield* makeChangeJournal(sql).current("organization:team-a", [key]), [
        { ...key, revision: "1" },
      ]);
    }).pipe(Effect.provide(pgliteLayer())),
  ));
const run = (work: Effect.Effect<void, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`create table executor_apps (id text primary key, owner text not null, active_deployment text)`;
      yield* migrateChangeRevisions;
      yield* work;
    }).pipe(Effect.provide(pgliteLayer())),
  );

test("a committed activation survives a crash before dispatch and a new journal delivers it", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into executor_apps values ('app-a', 'organization:team-a', null)`;
      yield* sql.withTransaction(
        sql`update executor_apps set active_deployment = 'build-1' where id = 'app-a'`,
      );
      // No request finalizer or delivery runs. A new dispatcher reconstructs everything from SQL.
      const recovered = makeChangeJournal(sql);
      const delivered: unknown[] = [];
      yield* recovered.deliver((scope, hint) =>
        Effect.sync(() => {
          delivered.push({ scope, ...hint });
        }),
      );
      assert.deepEqual(delivered, [{ scope: "organization:team-a", ...key, revision: "1" }]);
      assert.deepEqual(yield* recovered.current("organization:team-a", [key]), [
        { ...key, revision: "1" },
      ]);
      yield* recovered.deliver(() => Effect.die("acknowledged rows must not be redelivered"));
    }),
  ));

test("the activation and pending hint survive closing and reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "basalt-notification-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table executor_apps (id text primary key, owner text not null, active_deployment text)`;
        yield* migrateChangeRevisions;
        yield* sql`insert into executor_apps values ('app-a', 'organization:team-a', 'build-1')`;
      }).pipe(Effect.provide(pgliteLayer({ dataDir: directory }))),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = makeChangeJournal(yield* SqlClient.SqlClient);
        const delivered: unknown[] = [];
        yield* journal.deliver((scope, hint) =>
          Effect.sync(() => {
            delivered.push({ scope, ...hint });
          }),
        );
        assert.deepEqual(delivered, [{ scope: "organization:team-a", ...key, revision: "1" }]);
      }).pipe(Effect.provide(pgliteLayer({ dataDir: directory }))),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rollback emits nothing and metadata-only updates do not change the deployment revision", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into executor_apps values ('app-a', 'organization:team-a', null)`;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`update executor_apps set active_deployment = 'rolled-back' where id = 'app-a'`;
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.result);
      const journal = makeChangeJournal(sql);
      assert.deepEqual(yield* journal.current("organization:team-a", [key]), [
        { ...key, revision: "0" },
      ]);
      yield* journal.deliver(() => Effect.die("a rollback cannot notify"));
      yield* sql`update executor_apps set active_deployment = 'build-1' where id = 'app-a'`;
      yield* sql`update executor_apps set active_deployment = 'build-1' where id = 'app-a'`;
      assert.deepEqual(yield* journal.current("organization:team-a", [key]), [
        { ...key, revision: "1" },
      ]);
    }),
  ));

test("a lost acknowledgement is retryable and a newer pending revision survives an older delivery", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into executor_apps values ('app-a', 'organization:team-a', 'build-1')`;
      const journal = makeChangeJournal(sql);
      const delivered: unknown[] = [];
      yield* journal
        .deliver((_scope, hint) =>
          Effect.gen(function* () {
            delivered.push(hint);
            return yield* Effect.fail("ack lost after send");
          }),
        )
        .pipe(Effect.result);
      yield* journal.deliver((_scope, hint) =>
        Effect.gen(function* () {
          delivered.push(hint);
          // A second writer commits while this delivery's acknowledgement is in flight.
          yield* sql`update executor_apps set active_deployment = 'build-2' where id = 'app-a'`;
        }),
      );
      yield* journal.deliver((_scope, hint) =>
        Effect.sync(() => {
          delivered.push(hint);
        }),
      );
      assert.deepEqual(delivered, [
        { ...key, revision: "1" },
        { ...key, revision: "1" },
        { ...key, revision: "2" },
      ]);
      yield* journal.deliver(() => Effect.die("all acknowledgements were recorded"));
    }),
  ));

test("a failed scope retains its hint without blocking another scope, and scopes have independent revisions", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into executor_apps values ('app-a', 'organization:team-a', 'build-1'), ('app-b', 'organization:team-b', 'build-1')`;
      const journal = makeChangeJournal(sql);
      const delivered: unknown[] = [];
      const attempt = yield* journal
        .deliver((scope, hint) =>
          scope === "organization:team-a"
            ? Effect.fail("unavailable")
            : Effect.sync(() => {
                delivered.push({ scope, ...hint });
              }),
        )
        .pipe(Effect.result);
      assert.equal(attempt._tag, "Failure");
      assert.deepEqual(delivered, [
        { scope: "organization:team-b", topic: "deployment", resource: "app-b", revision: "1" },
      ]);
      yield* journal.deliver((scope, hint) =>
        Effect.sync(() => {
          delivered.push({ scope, ...hint });
        }),
      );
      assert.deepEqual(delivered[1], { scope: "organization:team-a", ...key, revision: "1" });
    }),
  ));

test("deletion retains a durable terminal head and owner transfer notifies both scopes", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into executor_apps values ('app-a', 'organization:team-a', 'build-1')`;
      yield* sql`update executor_apps set owner = 'organization:team-b' where id = 'app-a'`;
      const journal = makeChangeJournal(sql);
      assert.deepEqual(yield* journal.current("organization:team-a", [key]), [
        { ...key, revision: "2" },
      ]);
      assert.deepEqual(yield* journal.current("organization:team-b", [key]), [
        { ...key, revision: "1" },
      ]);
      yield* sql`delete from executor_apps where id = 'app-a'`;
      assert.deepEqual(yield* journal.current("organization:team-b", [key]), [
        { ...key, revision: "2" },
      ]);
    }),
  ));
