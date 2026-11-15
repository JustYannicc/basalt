import assert from "node:assert/strict";
import { test } from "node:test";
import { Context, Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { readWithStableFacts } from "../../.upstream/apps/hosted/server/src/implementation/pool-account-read-facts.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { fixture, key } from "./account-change-fixture.ts";

const Facts = Context.Reference<{ readonly label: string } | undefined>("test/PoolFacts", {
  defaultValue: () => undefined,
});

test("a head advancing during a pool read renders one fresh uncached answer", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const head = makeChangeJournal(sql)
        .current("organization:team-a", [key("accounts")])
        .pipe(Effect.map(JSON.stringify));
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const facts = sql`select label from executor_accounts where id='acc_a'`.pipe(
        Effect.map((rows) => ({ label: String(rows[0]!.label) })),
      );
      let reads = 0;
      const read = Effect.gen(function* () {
        reads++;
        const cached = yield* Facts;
        if (cached !== undefined) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        return cached ?? (yield* facts);
      });
      const rendered = yield* readWithStableFacts(head, facts, read, (facts, work) =>
        Effect.provideService(work, Facts, facts),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* sql`update executor_accounts set label='Current reading' where id='acc_a'`;
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(yield* Fiber.join(rendered), { label: "Current reading" });
      assert.equal(reads, 2);
      assert.equal(yield* Facts, undefined);
    }),
  ));

for (const [label, unavailable] of Object.entries({
  absent: Effect.succeed(undefined),
  unavailable: Effect.fail("journal unavailable"),
})) {
  test(`an ${label} head uses the uncached read`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let facts = 0;
        const result = yield* readWithStableFacts(
          unavailable,
          Effect.sync(() => ++facts),
          Effect.succeed("fresh"),
          () => Effect.succeed("stale"),
        );
        assert.equal(result, "fresh");
        assert.equal(facts, 0);
      }),
    ));
}

test("a failed speculative read retries uncached when its head moved", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let head = "before";
      const result = yield* readWithStableFacts(
        Effect.sync(() => head),
        Effect.void,
        Effect.succeed("current"),
        () =>
          Effect.suspend(() => {
            head = "after";
            return Effect.fail("superseded");
          }),
      );
      assert.equal(result, "current");
    }),
  ));

test("each request loads new raw facts and sees revocation on the next read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let role = "admin";
      let loads = 0;
      const facts = Effect.sync(() => {
        loads++;
        return role;
      });
      const Role = Context.Reference<string | undefined>("test/PoolRole", {
        defaultValue: () => undefined,
      });
      const read = Effect.map(Role, (raw) =>
        (raw ?? role) === "admin" ? { visible: true } : { visible: false },
      );
      const query = () =>
        readWithStableFacts(
          Effect.sync(() => role),
          facts,
          read,
          (raw, work) => Effect.provideService(work, Role, raw),
        );
      assert.deepEqual(yield* query(), { visible: true });
      role = "member";
      assert.deepEqual(yield* query(), { visible: false });
      assert.equal(loads, 2);
    }),
  ));

test("an unchanged head preserves a real read failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* readWithStableFacts(
        Effect.succeed("same"),
        Effect.void,
        Effect.fail("denied"),
        (_facts, read) => read,
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure, "denied");
    }),
  ));
