import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Effect, Exit, Layer, Queue, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import { migrateDeferredChanges } from "../../.upstream/apps/hosted/server/src/implementation/deferred-change-schema.ts";
import { committedChangeDelivery } from "../../.upstream/apps/hosted/self-host/src/implementation/committed-change-delivery.ts";
import { fixturePhases } from "../upstream-fixture-phases.ts";

// Embedded database startup is fixture setup; the unchanged five-second test bounds delivery.
const scope = Scope.makeUnsafe();
const initialize = () => Effect.runPromise(Layer.buildWithScope(pgliteLayer(), scope));
let services: Awaited<ReturnType<typeof initialize>>;
before(
  async () => {
    services = await initialize();
  },
  { timeout: 10_000 },
);
after(() => Effect.runPromise(Scope.close(scope, Exit.void)), { timeout: 5_000 });

// Each delivery must arrive before the test makes another write that could hide a missed wake-up.
test(
  "self-host delivers each lone commit without waiting for another notification",
  { timeout: 5_000 },
  (t) => {
    // Phase markers carry monotonic elapsed times, so a timeout names the wait it stopped in.
    const phase = fixturePhases(t, "lone-commit-delivery");
    return Effect.runPromise(
      Effect.gen(function* () {
        phase.waiting("schema");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table executor_apps (id text primary key, owner text not null, active_deployment text)`;
        yield* migrateChangeRevisions;
        yield* migrateDeferredChanges;
        yield* sql`insert into executor_apps values ('app-a', 'organization:team-a', null)`;
        phase.reached("schema");
        const delivered = yield* Queue.unbounded<{
          readonly scope: string;
          readonly revision: string;
        }>();
        phase.waiting("listener and recovery");
        yield* committedChangeDelivery((scope, hint) =>
          Effect.gen(function* () {
            phase.reached(`worker delivered revision ${hint.revision}`);
            yield* Queue.offer(delivered, { scope, revision: hint.revision });
          }),
        );
        // The serialized SQL read follows the worker's initial empty recovery pass.
        yield* Effect.yieldNow;
        yield* sql`select 1`;
        phase.reached("listener and recovery");
        for (const revision of ["1", "2"]) {
          phase.waiting(`commit of revision ${revision}`);
          yield* sql.withTransaction(
            sql`update executor_apps set active_deployment = ${`build-${revision}`} where id='app-a'`,
          );
          phase.reached(`commit of revision ${revision}`);
          phase.waiting(`delivery of revision ${revision}`);
          assert.deepEqual(yield* Queue.take(delivered), {
            scope: "organization:team-a",
            revision,
          });
          phase.reached(`delivery of revision ${revision}`);
        }
        phase.waiting("cleanup");
      }).pipe(Effect.scoped, Effect.provide(services)),
      { signal: t.signal },
    ).then(() => phase.complete());
  },
);
