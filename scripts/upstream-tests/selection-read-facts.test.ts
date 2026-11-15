import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { database, type Query } from "../../.upstream/packages/sdk/src/implementation/database.ts";
import { cachedFact } from "../../.upstream/packages/sdk/src/implementation/selection-read-facts.ts";
import { fixture } from "./account-change-fixture.ts";

test("raw rows single-flight within one query and remain isolated from consumers and other databases", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const db = database(yield* makeExecutorStorage({ provider: "postgresql" }));
      let reads = 0;
      const read = sql`select label from executor_accounts where id='acc_a'`.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            reads++;
          }),
        ),
      );
      const cache = new WeakMap<Query, Map<string, typeof read>>();
      const [first, second] = yield* Effect.all(
        [cachedFact(cache, db, "account", read), cachedFact(cache, db, "account", read)],
        { concurrency: "unbounded" },
      );
      assert.equal(reads, 1);
      assert.deepEqual(first, second);
      first[0]!.label = "consumer changed its copy";
      assert.equal((yield* cachedFact(cache, db, "account", read))[0]!.label, "Retained");
      const other = database(yield* makeExecutorStorage({ provider: "postgresql" }));
      yield* cachedFact(cache, other, "account", read);
      assert.equal(reads, 2);
    }),
  ));

test("SQL transactions and the next request never reuse an earlier raw fact", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const db = database(yield* makeExecutorStorage({ provider: "postgresql" }));
      const read = sql`select label from executor_accounts where id='acc_a'`;
      const cache = new WeakMap<Query, Map<string, typeof read>>();
      assert.equal((yield* cachedFact(cache, db, "account", read))[0]!.label, "Retained");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`update executor_accounts set label='Current' where id='acc_a'`;
          assert.equal((yield* cachedFact(cache, db, "account", read))[0]!.label, "Current");
        }),
      );
      assert.equal(
        (yield* cachedFact(new WeakMap<Query, Map<string, typeof read>>(), db, "account", read))[0]!
          .label,
        "Current",
      );
    }),
  ));
