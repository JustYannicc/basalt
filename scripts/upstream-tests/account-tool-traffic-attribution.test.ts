import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ToolAccountObservation } from "../../.upstream/packages/apps/src/contracts/host.ts";
import { AccountId } from "../../.upstream/packages/sdk/src/core.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { makeToolCallAccounting } from "../../.upstream/packages/sdk/src/implementation/account-tool-traffic.ts";
import { makeAccountTrafficStore } from "../../.upstream/packages/sdk/src/implementation/account-traffic-store.ts";
import { migrateAccountTraffic } from "../../.upstream/packages/sdk/src/implementation/storage-migrations.ts";

const a = AccountId.make("acc_attribution_a");
const b = AccountId.make("acc_attribution_b");
const foreign = AccountId.make("acc_attribution_foreign");
const at = Date.now();
const run = (selected: readonly AccountId[], reported?: readonly string[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* migrateAccountTraffic;
      const store = makeAccountTrafficStore(yield* SqlClient.SqlClient);
      const call = Effect.gen(function* () {
        if (reported !== undefined) (yield* ToolAccountObservation).used(reported);
        return { status: "completed" };
      });
      yield* call.pipe(makeToolCallAccounting(store, undefined)(selected, () => true));
      return yield* store.read({ accounts: [a, b, foreign], from: at - 3_600_000 });
    }).pipe(Effect.provide(pgliteLayer())),
  );

test("a retained bundle without account-use evidence remains callable without crediting every account", async () => {
  assert.deepEqual(await run([a, b]), []);
});

test("a retained bundle with only one available account keeps its traffic", async () => {
  const rows = await run([a]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.account, a);
  assert.equal(rows[0]?.hours[0]?.requests, 1);
  assert.equal(rows[0]?.hours[0]?.failed, 0);
  assert.notEqual(rows[0]?.lastSuccessAt, null);
});

test("account-use evidence cannot credit an account the invocation did not select", async () => {
  assert.deepEqual(await run([a, b], [foreign]), []);
});

test("explicitly empty evidence never falls back to an available account", async () => {
  assert.deepEqual(await run([a], []), []);
});

test("repeated evidence credits the serving account once and leaves the other idle", async () => {
  const rows = await run([a, b], [a, a]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.account, a);
  assert.equal(rows[0]?.hours[0]?.requests, 1);
});
