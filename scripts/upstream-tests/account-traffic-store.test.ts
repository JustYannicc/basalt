import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const { makeAccountTrafficStore, accountTrafficRetention } = (await import(
  new URL("packages/sdk/src/implementation/account-traffic-store.ts", upstream).href
)) as typeof import("../../.upstream/packages/sdk/src/implementation/account-traffic-store.ts");

const hour = 3_600_000;
// Real time: reads keep only the retention window before the clock.
const now = Date.now();
const run = <A>(body: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(body.pipe(Effect.provide(pgliteLayer())) as Effect.Effect<A, unknown>);

test("counts each call per account and hour, with failures and the latest success", () =>
  run(
    Effect.gen(function* () {
      const store = makeAccountTrafficStore(yield* SqlClient.SqlClient);
      const [a, b] = ["acc_traffic_a", "acc_traffic_b"] as never[];
      // The table creates itself on the first read, which then lists nothing.
      assert.deepEqual(yield* store.read({ accounts: [a], from: now - 7 * 24 * hour }), []);
      yield* store.record({ accounts: [a, b, a], at: now - 2 * hour, ok: true });
      yield* store.record({ accounts: [a], at: now - 2 * hour + 60_000, ok: false });
      yield* store.record({ accounts: [a], at: now, ok: true });
      yield* store.record({ accounts: [b], at: now - 30_000, ok: false });
      const read = yield* store.read({ accounts: [a, b], from: now - 7 * 24 * hour });
      const byAccount = Object.fromEntries(read.map((entry) => [entry.account, entry]));
      const start = (at: number) => Math.floor(at / hour) * hour;
      assert.deepEqual(byAccount.acc_traffic_a, {
        account: "acc_traffic_a",
        // A call naming the same account twice counts once for it.
        hours: [
          { at: start(now - 2 * hour), requests: 2, failed: 1 },
          { at: start(now), requests: 1, failed: 0 },
        ],
        lastSuccessAt: now,
      });
      // A failure never moves the latest success.
      assert.deepEqual(byAccount.acc_traffic_b, {
        account: "acc_traffic_b",
        hours: [
          { at: start(now - 2 * hour), requests: 1, failed: 0 },
          { at: start(now), requests: 1, failed: 1 },
        ],
        lastSuccessAt: now - 2 * hour,
      });
      // Only the asked accounts, and only hours since `from`; the latest success still shows.
      const recent = yield* store.read({ accounts: [a], from: now - 30 * 60_000 });
      assert.deepEqual(recent, [
        {
          account: "acc_traffic_a",
          hours: [{ at: start(now), requests: 1, failed: 0 }],
          lastSuccessAt: now,
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

test("concurrent first calls create the table once and lose no count", () =>
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
