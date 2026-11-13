import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { fixture, key } from "./account-change-fixture.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { makePoolViewCache } from "../../.upstream/apps/hosted/server/src/implementation/pool-view-cache.ts";

for (const change of ["name", "membership", "repository"]) {
  test(
    change === "repository"
      ? "repository initialization preserves an in-flight view and its warm reuse"
      : `a real ${change} write still rejects an in-flight view`,
    () =>
      fixture(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const journal = makeChangeJournal(sql);
          const guard = journal
            .current("organization:team-a", [key("accounts"), key("apps"), key("membership")])
            .pipe(Effect.map((revisions) => ({ revisions })));
          const before = yield* guard;
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const cache = makePoolViewCache();
          let calls = 0;
          const value = { windows: [0.8], canInspect: true };
          const read = Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return value;
          });
          const fill = yield* cache("request-bound-viewer", guard, read).pipe(
            Effect.result,
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          if (change === "repository")
            yield* sql`update executor_apps set repository=code where id='app_a' and repository is null`;
          else if (change === "name")
            yield* sql`update executor_apps set name='Real source rename' where id='app_a'`;
          else yield* sql`update member set role='admin' where id='member-a'`;
          const after = yield* guard;
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(fill);
          if (change === "repository") {
            assert.equal(
              result._tag,
              "Success",
              "repository recovery must not reject an unchanged view",
            );
            assert.deepEqual(
              after,
              before,
              "repository creation changes source readiness, not selected accounts or the active app",
            );
            assert.deepEqual(yield* cache("request-bound-viewer", guard, read), value);
            assert.equal(calls, 1, "the unchanged warm view reuses its accepted fill");
          } else {
            assert.equal(
              result._tag,
              "Failure",
              "real source or authority changes must still reject the in-flight value",
            );
            assert.notDeepEqual(after, before);
          }
        }),
      ),
  );
}
