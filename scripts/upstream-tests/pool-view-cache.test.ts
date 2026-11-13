import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Deferred, Effect, Fiber, type Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { makePoolViewCache } from "../../.upstream/apps/hosted/server/src/implementation/pool-view-cache.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { fixture, key } from "./account-change-fixture.ts";
import { UiFailed, UiVersionChanged } from "../../.upstream/packages/apps/src/contracts/ui.ts";

test("unchanged real journal heads skip source work; saved source and permission writes invalidate it", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = makeChangeJournal(sql);
      const guard = journal
        .current("organization:team-a", [key("accounts"), key("apps"), key("membership")])
        .pipe(Effect.map((revisions) => ({ revisions })));
      const cache = makePoolViewCache();
      let calls = 0;
      let inspect = true;
      const read = Effect.sync((): Schema.Json => {
        calls++;
        return inspect ? { label: "Provider", windows: [5] } : { windows: [] };
      });
      const load = () => cache("viewer-a/session-a/pool-a", guard, read);
      assert.deepEqual(yield* load(), { label: "Provider", windows: [5] });
      for (let i = 0; i < 12; i++)
        assert.deepEqual(yield* load(), { label: "Provider", windows: [5] });
      assert.equal(calls, 1);
      yield* sql`update executor_accounts set label='Source renamed' where id='acc_a'`;
      yield* load();
      assert.equal(calls, 2);
      inspect = false;
      yield* sql`update member set role='admin' where id='member-a'`;
      assert.deepEqual(yield* load(), { windows: [] });
      assert.equal(calls, 3);
      assert.deepEqual(yield* cache("other-viewer", guard, read), { windows: [] });
      assert.equal(calls, 4);
    }),
  ));

test("a failed guard drops cached data and never falls back to it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      let denied = false,
        calls = 0;
      const guard = Effect.suspend(() =>
        denied ? Effect.fail("denied") : Effect.succeed({ revisions: [] }),
      );
      const read = Effect.sync(() => {
        calls++;
        return { windows: [1] };
      });
      yield* cache("caller", guard, read);
      denied = true;
      assert.equal((yield* Effect.result(cache("caller", guard, read)))._tag, "Failure");
      denied = false;
      yield* cache("caller", guard, read);
      assert.equal(calls, 2);
    }),
  ));

test("a write during a fill rejects the result instead of publishing the old allowance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      let revision = "1";
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const guard = Effect.sync(() => ({
        revisions: [{ topic: "accounts", resource: "*", revision }],
      }));
      const read = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return { windows: [1] };
      });
      const fiber = yield* cache("caller", guard, read).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      revision = "2";
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
    }),
  ));

test("expired authority is refused even when the head did not change", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      let expiry = Date.now() + 60_000;
      let calls = 0;
      const guard = Effect.sync(() => ({ revisions: [], validUntil: expiry }));
      const read = Effect.sync(() => {
        calls++;
        return { windows: [1] };
      });
      yield* cache("caller", guard, read);
      expiry = 0;
      assert.equal((yield* Effect.result(cache("caller", guard, read)))._tag, "Failure");
      assert.equal(calls, 1);
    }),
  ));

test("the source freshness deadline invalidates an unchanged revision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      const guard = Effect.succeed({ revisions: [] });
      let calls = 0;
      const read = Effect.sync(() => {
        calls++;
        return { staleAt: "1970-01-01T00:00:01.000Z", windows: [calls] };
      });
      yield* cache("caller", guard, read);
      yield* cache("caller", guard, read);
      assert.equal(calls, 1);
      yield* TestClock.adjust(1001);
      assert.deepEqual(yield* cache("caller", guard, read), {
        staleAt: "1970-01-01T00:00:01.000Z",
        windows: [2],
      });
    }).pipe(Effect.provide(TestClock.layer())),
  ));

for (const homeDeadline of [undefined, 900_000]) {
  test(`an observedAt-only report expires from a warm cache with ${homeDeadline === undefined ? "no" : "a later"} Home deadline`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const cache = makePoolViewCache();
        const guard = Effect.succeed({ revisions: [], validUntil: homeDeadline });
        const result = {
          observedAt: "1970-01-01T00:00:00.000Z",
          observation: { offering: "subscription", windows: [], balances: [] },
        };
        const view = (freshness: string) => ({ reports: [{ result, freshness }] });
        let calls = 0;
        const read = Effect.gen(function* () {
          calls++;
          const now = yield* Clock.currentTimeMillis;
          return view(now < 300_000 ? "fresh" : "stale");
        });
        const load = () => cache("caller", guard, read);
        assert.deepEqual(yield* load(), view("fresh"));
        yield* TestClock.adjust(299_999);
        assert.deepEqual(yield* load(), view("fresh"));
        assert.equal(calls, 1, "the request immediately before expiry is a warm hit");
        yield* TestClock.adjust(1);
        assert.deepEqual(yield* load(), view("stale"));
        assert.equal(calls, 2, "the source is read again at its default freshness cutoff");
        yield* TestClock.adjust(1);
        assert.deepEqual(yield* load(), view("stale"));
        assert.equal(calls, 2, "a safely stale result is reusable with unchanged heads");
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  test(`a fill crossing the source cutoff cannot cache a fresh report with ${homeDeadline === undefined ? "no" : "a later"} Home deadline`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const cache = makePoolViewCache();
        const guard = Effect.succeed({ revisions: [], validUntil: homeDeadline });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const result = {
          observedAt: "1970-01-01T00:00:00.000Z",
          observation: { offering: "subscription", windows: [], balances: [] },
        };
        const view = (freshness: string) => ({ reports: [{ result, freshness }] });
        let calls = 0;
        const read = Effect.gen(function* () {
          calls++;
          const now = yield* Clock.currentTimeMillis;
          const snapshot = view(now < 300_000 ? "fresh" : "stale");
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return snapshot;
        });
        const load = () => cache("caller", guard, read);
        yield* TestClock.adjust(299_999);
        const fill = yield* load().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust(2);
        yield* Deferred.succeed(release, undefined);
        assert.deepEqual(yield* Fiber.join(fill), view("fresh"));
        assert.deepEqual(yield* load(), view("stale"));
        assert.deepEqual(yield* load(), view("stale"));
        assert.equal(calls, 2, "the expired fill is discarded and its stale replacement is reused");
      }).pipe(Effect.provide(TestClock.layer())),
    ));
}

test("overlapping unchanged requests share one source fill", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const read = Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return { windows: [1] };
      });
      const work = Effect.all(
        [1, 2, 3].map(() => cache("caller", Effect.succeed({ revisions: [] }), read)),
        { concurrency: "unbounded" },
      );
      const fiber = yield* work.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(fiber)).length, 3);
      assert.equal(calls, 1);
    }),
  ));

test("a temporary source failure is retried without a revision write", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      let calls = 0;
      const guard = Effect.succeed({ revisions: [] });
      const read = Effect.sync(() => (++calls === 1 ? { ok: false } : { ok: true }));
      assert.deepEqual(yield* cache("caller", guard, read), { ok: false });
      assert.deepEqual(yield* cache("caller", guard, read), { ok: true });
      yield* cache("caller", guard, read);
      assert.equal(calls, 2);
    }),
  ));

test("an app without a pool registration executes normally without contacting Home heads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cache = makePoolViewCache();
      let reads = 0;
      const load = () =>
        cache(
          "lookalike",
          Effect.fail("Home must not be contacted"),
          Effect.sync(() => ({ count: ++reads })),
          Effect.succeed(false),
        );
      assert.deepEqual(yield* load(), { count: 1 });
      assert.deepEqual(yield* load(), { count: 2 });
    }),
  ));

for (const eligible of [false, true]) {
  for (const error of [new UiFailed({ reason: "account_required" }), new UiVersionChanged()]) {
    test(`a ${eligible ? "cacheable" : "non-pool"} read preserves ${error._tag} recovery`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const cache = makePoolViewCache();
          const failure = yield* cache(
            "caller",
            Effect.succeed({ revisions: [] }),
            Effect.fail(error),
            Effect.succeed(eligible),
          ).pipe(Effect.flip);
          assert.equal(failure, error);
        }),
      ));
  }
}
