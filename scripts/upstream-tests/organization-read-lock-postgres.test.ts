import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PgClient } from "@effect/sql-pg";
import { Deferred, Effect, Fiber, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import {
  withOrganizationAccessLock,
  withOrganizationReadLock,
} from "../../.upstream/apps/hosted/server/src/implementation/organization-access-lock.ts";

const url = process.env.POOL_TEST_ADMIN_URL;
const localPostgres =
  url !== undefined && ["127.0.0.1", "localhost"].includes(new URL(url).hostname);

interface Held {
  readonly mode: string;
  readonly granted: boolean;
}

/** Waits for a database milestone; the deadline only turns a missing one into a failure. */
const until = <A, E, R>(read: Effect.Effect<A, E, R>, ready: (value: A) => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000;
    while (true) {
      const value = yield* read;
      if (ready(value) || Date.now() >= deadline) return value;
    }
  });

// The pool's membership read runs inside `withOrganizationReadLock` (carry 0802). The test holds
// readers and a writer in sessions of its own and reads the database's lock view at each step, so
// no step depends on timing.
test(
  "membership readers share the organization lock and a writer waits for every one of them",
  { skip: !localPostgres, timeout: 30_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const organization = `org_read_lock_${randomUUID()}`;
          const locks = sql<Held>`select l.mode, l.granted from pg_locks l,
              (select hashtextextended(${`executor-access:${organization}`}, 0) as k) key
            where l.locktype = 'advisory' and l.objsubid = 1
              and l.classid::bigint = (key.k >> 32) & 4294967295
              and l.objid::bigint = key.k & 4294967295
            order by l.granted desc, l.mode`;
          const reader = Effect.gen(function* () {
            const inside = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const fiber = yield* withOrganizationReadLock(
              organization,
              Deferred.succeed(inside, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ).pipe(Effect.forkChild);
            yield* Deferred.await(inside);
            return { fiber, release: Deferred.succeed(release, undefined) };
          });

          // Two readers hold the lock at once: the second is not blocked by the first.
          const first = yield* reader;
          const second = yield* reader;

          // A writer asks for the lock exclusively and is shown waiting by the database.
          const wrote = yield* Deferred.make<void>();
          const writer = yield* withOrganizationAccessLock(
            organization,
            Deferred.succeed(wrote, undefined),
          ).pipe(Effect.forkChild);
          const queued = yield* until(
            Effect.zip(locks, Deferred.isDone(wrote)),
            ([rows, done]) => done || rows.some((row) => !row.granted),
          );
          assert.equal(yield* Deferred.isDone(wrote), false, "the writer waits for the readers");
          // Both readers hold the lock shared; the writer's exclusive request waits behind them.
          assert.deepEqual(
            queued[0],
            [
              { mode: "ShareLock", granted: true },
              { mode: "ShareLock", granted: true },
              { mode: "ExclusiveLock", granted: false },
            ],
            "the database shows both readers holding and the writer waiting",
          );

          // One reader ends: the writer still waits for the other.
          yield* first.release;
          yield* Fiber.join(first.fiber);
          const one = yield* until(locks, (rows) => rows.filter((row) => row.granted).length === 1);
          assert.deepEqual(one, [
            { mode: "ShareLock", granted: true },
            { mode: "ExclusiveLock", granted: false },
          ]);
          assert.equal(yield* Deferred.isDone(wrote), false, "the writer waits for every reader");

          // The last reader ends: the writer runs and finishes.
          yield* second.release;
          yield* Fiber.join(second.fiber);
          yield* Fiber.join(writer);
          assert.equal(yield* Deferred.isDone(wrote), true);
          assert.deepEqual(yield* locks, []);
        }).pipe(
          Effect.provide(PgClient.layer({ url: Redacted.make(url ?? ""), maxConnections: 4 })),
        ),
      ),
    ),
);
