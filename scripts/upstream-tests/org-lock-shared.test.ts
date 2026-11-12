import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { CurrentUserId } from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import {
  readPool,
  withPool,
} from "../../.upstream/apps/hosted/server/src/implementation/pool-backend.ts";
import { withOrganizationAccessLock } from "../../.upstream/apps/hosted/server/src/implementation/organization-access-lock.ts";
import {
  poolUsage,
  setPoolCap,
} from "../../.upstream/apps/hosted/server/src/implementation/pool-usage.ts";
import { importPoolUsage } from "../../.upstream/apps/hosted/server/src/implementation/pool-usage-import.ts";
import {
  app,
  caller,
  organization,
  owner,
  postgresFixture,
  until,
} from "./org-lock-postgres-fixture.ts";

test("same-organization reporting readers reach the receiver concurrently", async () => {
  await postgresFixture(({ requests, hold, arrived, locks }) =>
    Effect.gen(function* () {
      const first = yield* poolUsage(app).pipe(Effect.forkChild);
      yield* Deferred.await(arrived);
      const second = yield* poolUsage(app).pipe(Effect.forkChild);
      const observed = yield* until(
        locks,
        (rows) => requests.length === 2 || rows.some((row) => !row.granted),
      );
      assert.equal(requests.length, 2, `second reader serialized: ${JSON.stringify(observed)}`);
      assert.deepEqual(
        observed.map((row) => row.mode),
        ["ShareLock", "ShareLock"],
      );
      hold.release();
      assert.equal((yield* Fiber.join(first))?.pool, app);
      assert.equal((yield* Fiber.join(second))?.pool, app);
    }),
  );
});

test("idempotent history-import pages retain shared authority through concurrent acknowledgments", async () => {
  await postgresFixture(({ requests, hold, arrived, locks }) =>
    Effect.gen(function* () {
      const page = (offset: number) =>
        importPoolUsage(app, {
          source: "11111111-1111-1111-1111-111111111111",
          format: "cpamp-v1-jsonl",
          mode: "apply",
          data: "",
          offset,
        }).pipe(Effect.provideService(CurrentUserId, owner));
      const first = yield* page(0).pipe(Effect.forkChild);
      yield* Deferred.await(arrived);
      const second = yield* page(200).pipe(Effect.forkChild);
      const observed = yield* until(
        locks,
        (rows) => requests.length === 2 || rows.some((row) => !row.granted),
      );
      assert.equal(requests.length, 2, `second import serialized: ${JSON.stringify(observed)}`);
      assert.ok(observed.every((row) => row.granted && row.mode === "ShareLock"));
      hold.release();
      assert.equal((yield* Fiber.join(first)).mode, "apply");
      assert.equal((yield* Fiber.join(second)).mode, "apply");
    }),
  );
});

for (const change of ["remove", "demote"] as const) {
  test(`a reader queued behind membership ${change} rechecks authority after commit`, async () => {
    await postgresFixture(({ sql, requests, hold, arrived, waiting }) =>
      Effect.gen(function* () {
        const first = yield* poolUsage(app).pipe(Effect.forkChild);
        yield* Deferred.await(arrived);
        const changed = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        const writer = yield* withOrganizationAccessLock(
          organization,
          Effect.gen(function* () {
            if (change === "remove") yield* sql`delete from member where "userId" = ${caller}`;
            else yield* sql`update member set role = 'member' where "userId" = ${caller}`;
            yield* Deferred.succeed(changed, undefined);
            yield* Deferred.await(commit);
          }),
        ).pipe(Effect.forkChild);
        yield* until(waiting, (rows) => rows.length === 1);
        const queued = yield* poolUsage(app).pipe(
          Effect.catchTag("OrganizationForbidden", () => Effect.succeed("forbidden")),
          Effect.forkChild,
        );
        yield* until(waiting, (rows) => rows.length === 2);
        assert.equal(requests.length, 1, "revocation waits for the in-flight acknowledgment");
        hold.release();
        yield* Deferred.await(changed);
        assert.equal(requests.length, 1, "queued reader cannot pass the uncommitted revocation");
        yield* Deferred.succeed(commit, undefined);
        yield* Fiber.join(writer);
        assert.equal((yield* Fiber.join(first))?.pool, app);
        assert.equal(yield* Fiber.join(queued), "forbidden");
        assert.equal(requests.length, 1, "revoked caller never reaches the receiver");
      }),
    );
  });
}

test("an exclusive cap writer excludes reporting readers until its acknowledgment", async () => {
  await postgresFixture(({ requests, hold, arrived, waiting }) =>
    Effect.gen(function* () {
      const writer = yield* setPoolCap(app, caller, 10).pipe(Effect.forkChild);
      yield* Deferred.await(arrived);
      const reader = yield* poolUsage(app).pipe(Effect.forkChild);
      const queued = yield* until(waiting, (rows) => rows.length === 1);
      assert.equal(queued[0]?.mode, "ShareLock");
      assert.deepEqual(requests, ["/pool/v1/managed-cap"]);
      hold.release();
      assert.deepEqual(yield* Fiber.join(writer), { success: true });
      assert.equal((yield* Fiber.join(reader))?.pool, app);
      assert.deepEqual(requests, ["/pool/v1/managed-cap", "/pool/v1/managed-usage"]);
    }),
  );
});

test("a fresh membership FOR SHARE remains held across the receiver call", async () => {
  await postgresFixture(({ sql, hold, arrived }) =>
    Effect.gen(function* () {
      const reader = yield* poolUsage(app).pipe(Effect.forkChild);
      yield* Deferred.await(arrived);
      const update = yield* sql`update member set role = 'member' where "userId" = ${caller}`.pipe(
        Effect.forkChild,
      );
      yield* until(
        sql`select pid from pg_stat_activity where application_name = current_setting('application_name')
      and wait_event_type = 'Lock' and query like 'update member%'`,
        (rows) => rows.length === 1,
      );
      hold.release();
      assert.equal((yield* Fiber.join(reader))?.pool, app);
      yield* Fiber.join(update);
      assert.equal(
        (yield* sql`select role from member where "userId" = ${caller}`)[0]?.role,
        "member",
      );
    }),
  );
});

for (const reason of ["failure", "timeout"] as const) {
  test(`RPC ${reason} releases shared authority and its membership row lock`, async () => {
    await postgresFixture(({ sql, hold, arrived, locks, fail }) =>
      Effect.gen(function* () {
        const reader = yield* poolUsage(app).pipe(
          Effect.catchTag("PoolUsageUnavailable", () => Effect.succeed("unavailable")),
          Effect.forkChild,
        );
        yield* Deferred.await(arrived);
        if (reason === "failure") {
          fail();
          hold.release();
        } else yield* TestClock.adjust(10_001);
        assert.equal(yield* Fiber.join(reader), "unavailable");
        assert.deepEqual(yield* locks, []);
        const acquired = yield* sql.withTransaction(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${`executor-access:${organization}`}, 0)) as acquired`,
        );
        assert.equal(acquired[0]?.acquired, true);
        yield* sql`update member set role = 'member' where "userId" = ${caller}`;
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
}

test("nested reporting transactions do not upgrade shared authority", async () => {
  await postgresFixture(({ requests, hold, arrived, locks }) =>
    Effect.gen(function* () {
      const nested = readPool(app, () => poolUsage(app));
      const first = yield* nested.pipe(Effect.forkChild);
      yield* Deferred.await(arrived);
      const second = yield* nested.pipe(Effect.forkChild);
      const observed = yield* until(
        locks,
        (rows) => requests.length === 2 || rows.some((row) => !row.granted),
      );
      assert.equal(requests.length, 2, JSON.stringify(observed));
      assert.ok(observed.every((row) => row.granted && row.mode === "ShareLock"));
      hold.release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(
        (yield* withPool(app, () => poolUsage(app)))?.pool,
        app,
        "exclusive writers can safely call nested reporting reads without upgrading",
      );
    }),
  );
});
