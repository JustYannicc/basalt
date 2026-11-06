import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const { makeAccountTrafficStore, accountTrafficRetention } = (await import(
  new URL("packages/sdk/src/implementation/account-traffic-store.ts", upstream).href
)) as typeof import("../../.upstream/packages/sdk/src/implementation/account-traffic-store.ts");

const { migrateAccountTraffic } = (await import(
  new URL("packages/sdk/src/implementation/storage-migrations.ts", upstream).href
)) as typeof import("../../.upstream/packages/sdk/src/implementation/storage-migrations.ts");

const hour = 3_600_000;
// Real time: reads keep only the retention window before the clock.
const now = Date.now();
const run = <A>(body: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(
    migrateAccountTraffic.pipe(
      Effect.andThen(body),
      Effect.provide(pgliteLayer()),
    ) as Effect.Effect<A, unknown>,
  );

const start = (at: number) => Math.floor(at / hour) * hour;
/** The hours `calls` fill, oldest first, bucketed by the time each call was recorded at. */
const hours = (calls: readonly { readonly at: number; readonly ok: boolean }[]) =>
  [...Map.groupBy(calls, (call) => start(call.at))]
    .sort(([a], [b]) => a - b)
    .map(([at, inHour]) => ({
      at,
      requests: inHour.length,
      failed: inHour.filter((call) => !call.ok).length,
    }));

// The real clock, and clocks pinned just past and just before an hour boundary (in the previous
// hour, inside retention), where calls seconds apart land in different hours.
const thisHour = start(now);
for (const [clock, at] of [
  ["the current time", now],
  ["ten seconds into an hour", thisHour - hour + 10_000],
  ["ten seconds before an hour ends", thisHour - 10_000],
] as const)
  test(`counts each call per account and hour, with failures and the latest success, at ${clock}`, () =>
    run(
      Effect.gen(function* () {
        const store = makeAccountTrafficStore(yield* SqlClient.SqlClient);
        const [a, b] = ["acc_traffic_a", "acc_traffic_b"] as never[];
        // A migrated table with nothing counted lists nothing.
        assert.deepEqual(yield* store.read({ accounts: [a], from: at - 7 * 24 * hour }), []);
        const early = { at: at - 2 * hour, ok: true };
        const earlyFailure = { at: at - 2 * hour + 60_000, ok: false };
        const latest = { at, ok: true };
        const recentFailure = { at: at - 30_000, ok: false };
        yield* store.record({ accounts: [a, b, a], ...early });
        yield* store.record({ accounts: [a], ...earlyFailure });
        yield* store.record({ accounts: [a], ...latest });
        yield* store.record({ accounts: [b], ...recentFailure });
        const read = yield* store.read({ accounts: [a, b], from: at - 7 * 24 * hour });
        const byAccount = Object.fromEntries(read.map((entry) => [entry.account, entry]));
        // A call naming the same account twice counts once for it.
        assert.deepEqual(byAccount.acc_traffic_a, {
          account: "acc_traffic_a",
          hours: hours([early, earlyFailure, latest]),
          lastSuccessAt: at,
        });
        // A failure never moves the latest success.
        assert.deepEqual(byAccount.acc_traffic_b, {
          account: "acc_traffic_b",
          hours: hours([early, recentFailure]),
          lastSuccessAt: at - 2 * hour,
        });
        // Only the asked accounts, and only hours since `from`; the latest success still shows.
        const from = at - 30 * 60_000;
        const recent = yield* store.read({ accounts: [a], from });
        assert.deepEqual(recent, [
          {
            account: "acc_traffic_a",
            hours: hours([early, earlyFailure, latest]).filter((entry) => entry.at >= start(from)),
            lastSuccessAt: at,
          },
        ]);
      }),
    ));

test("an account with only failures has no latest success, and old hours are dropped", () =>
  run(
    Effect.gen(function* () {
      const store = makeAccountTrafficStore(yield* SqlClient.SqlClient);
      const account = "acc_traffic_failing" as never;
      yield* store.record({
        accounts: [account],
        at: now - accountTrafficRetention - hour,
        ok: true,
      });
      yield* store.record({ accounts: [account], at: now, ok: false });
      const [entry] = yield* store.read({ accounts: [account], from: 0 });
      assert.deepEqual(entry, {
        account: "acc_traffic_failing",
        hours: [{ at: Math.floor(now / hour) * hour, requests: 1, failed: 1 }],
        lastSuccessAt: null,
      });
      // An idle account's hours past retention are never read, though no write has dropped them.
      const idle = "acc_traffic_idle" as never;
      yield* store.record({ accounts: [idle], at: now - accountTrafficRetention - hour, ok: true });
      assert.deepEqual(yield* store.read({ accounts: [idle], from: 0 }), []);
    }),
  ));

test("concurrent calls lose no count", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeAccountTrafficStore(sql);
      const other = makeAccountTrafficStore(sql);
      const account = "acc_traffic_concurrent" as never;
      yield* Effect.all(
        Array.from({ length: 6 }, (_, index) =>
          (index % 2 === 0 ? store : other).record({ accounts: [account], at: now, ok: true }),
        ),
        { concurrency: "unbounded" },
      );
      const [entry] = yield* store.read({ accounts: [account], from: now - hour });
      assert.equal(entry?.hours[0]?.requests, 6);
    }),
  ));
