import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import type { Executor } from "@executor-js/sdk/core";
import { runRecheckFixture } from "./account-recheck-fixture.ts";
import { makeAccountRechecks } from "../.upstream/apps/hosted/server/src/implementation/account-rechecks.ts";

const staleHealth: Executor["accounts"]["health"] = ({ account, apps }) =>
  Effect.succeed({
    account,
    info: null,
    infoCheckedAt: null,
    apps: apps.map((app) => ({ app, checkable: true, check: null })),
  });

test("late batch completion retains a full minute of family spacing", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      yield* f.add("late-a", "vendor");
      yield* f.add("late-b", "vendor");
      const [first] = yield* f.queue.claim("late");
      assert.ok(first);
      // Claim-time spacing has elapsed while this account waited behind another worker.
      yield* f.sql`update hosted_account_rechecks set started_at=now()-interval '2 minutes', provider_next_at=now()-interval '1 second'`;
      yield* f.queue.finish(first.account, "late", "healthy", false);
      assert.deepEqual(yield* f.queue.claim("next-tick"), []);
    }),
  ));

test("family rate limits survive deletion of the account that received them", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      yield* f.add("deleted-a", "vendor");
      yield* f.add("deleted-b", "vendor");
      const [first] = yield* f.queue.claim("limited");
      assert.ok(first);
      yield* f.queue.finish(first.account, "limited", "failed", true, true);
      yield* f.sql`delete from executor_accounts where id=${first.account}`;
      assert.deepEqual(yield* f.queue.claim("after-deletion"), []);
    }),
  ));

test("an app check retains rate limiting returned by its driver's check", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      yield* f.add("app-a", "vendor");
      yield* f.add("app-b", "vendor");
      const check: Executor["accounts"]["check"] = ({ account, apps }) =>
        Effect.succeed({
          account,
          info: null,
          infoCheckedAt: null,
          driver: {
            source: { kind: "driver", id: "fixture", version: "1" },
            checkable: true,
            check: {
              status: "check_failed",
              current: true,
              checkedAt: new Date(),
              reason: "rate_limited",
            },
          },
          apps: apps.map((app) => ({
            app,
            checkable: true,
            check: { status: "healthy", current: true, checkedAt: new Date() },
          })),
        });
      yield* makeAccountRechecks(f.sql, { accounts: { health: staleHealth, check } })(
        "driver-limited",
      );
      const [run] = yield* f.sql`select outcome from hosted_account_rechecks`;
      assert.equal(run?.outcome, "failed");
      yield* f.sql`update hosted_account_rechecks set provider_next_at=least(provider_next_at, now()-interval '1 second')`;
      assert.deepEqual(yield* f.queue.claim("next"), []);
      const [gate] =
        yield* f.sql`select next_at > now()+interval '14 minutes' as delayed from hosted_account_recheck_families where provider_key='vendor'`;
      assert.equal(gate?.delayed, true);
    }),
  ));

test("an interrupted attempt retains cooldown after its persisted rate-limit result", () =>
  runRecheckFixture((f) =>
    Effect.gen(function* () {
      yield* f.add("crash-a", "vendor");
      yield* f.add("crash-b", "vendor");
      const persisted = yield* Deferred.make<void>();
      const check: Executor["accounts"]["check"] = ({ account, apps }) =>
        Effect.gen(function* () {
          yield* f.sql`insert into executor_account_checks(account,app,deployment,credential_generation,checked_at,status,account_info)
        values (${account}, ${apps[0]}, 'v2', 2, now(), 'check_failed', '{"checkReason":"rate_limited"}')`.pipe(
            Effect.orDie,
          );
          yield* Deferred.succeed(persisted, undefined);
          return yield* Effect.never;
        });
      const fiber = yield* makeAccountRechecks(f.sql, { accounts: { health: staleHealth, check } })(
        "crashed",
      ).pipe(Effect.forkChild);
      yield* Deferred.await(persisted);
      yield* Fiber.interrupt(fiber);
      yield* f.sql`update hosted_account_rechecks set lease_until=now()-interval '1 second', next_at=now()-interval '1 second', provider_next_at=now()-interval '1 second', started_at=now()-interval '6 minutes'`;
      assert.deepEqual(yield* f.queue.claim("reclaimed"), []);
      const [gate] =
        yield* f.sql`select next_at > now()+interval '14 minutes' as delayed from hosted_account_recheck_families where provider_key='vendor'`;
      assert.equal(gate?.delayed, true);
      yield* f.sql`update hosted_account_recheck_families set next_at=now()-interval '1 second'`;
      assert.equal((yield* f.queue.claim("after-cooldown")).length, 1);
    }),
  ));
