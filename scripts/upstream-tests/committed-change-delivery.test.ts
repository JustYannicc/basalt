import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Queue } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import { migrateDeferredChanges } from "../../.upstream/apps/hosted/server/src/implementation/deferred-change-schema.ts";
import { committedChangeDelivery } from "../../.upstream/apps/hosted/self-host/src/implementation/committed-change-delivery.ts";

// Each delivery must arrive before the test makes another write that could hide a missed wake-up.
test(
  "self-host delivers each lone commit without waiting for another notification",
  { timeout: 5_000 },
  (t) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table executor_apps (id text primary key, owner text not null, active_deployment text)`;
        yield* migrateChangeRevisions;
        yield* migrateDeferredChanges;
        yield* sql`insert into executor_apps values ('app-a', 'organization:team-a', null)`;
        const delivered = yield* Queue.unbounded<{
          readonly scope: string;
          readonly revision: string;
        }>();
        yield* committedChangeDelivery((scope, hint) =>
          Queue.offer(delivered, { scope, revision: hint.revision }).pipe(Effect.asVoid),
        );
        // The serialized SQL read follows the worker's initial empty recovery pass.
        yield* Effect.yieldNow;
        yield* sql`select 1`;
        for (const revision of ["1", "2"]) {
          yield* sql.withTransaction(
            sql`update executor_apps set active_deployment = ${`build-${revision}`} where id='app-a'`,
          );
          assert.deepEqual(yield* Queue.take(delivered), {
            scope: "organization:team-a",
            revision,
          });
        }
      }).pipe(Effect.scoped, Effect.provide(pgliteLayer())),
      { signal: t.signal },
    ),
);
