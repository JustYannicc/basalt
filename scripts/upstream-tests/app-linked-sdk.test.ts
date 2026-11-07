import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { counted, sdkFixture } from "./app-linked-sdk-fixture.ts";
import { sdk } from "./provider-destinations-modules.ts";

for (const saved of [48, 96])
  for (const linked of [1, 3, 15, 30])
    test(`account/identity/target block takes four queries with ${linked} linked of ${saved} saved`, async () => {
      await Effect.runPromise(
        sdkFixture(
          ({ executor, owner, ids }) =>
            Effect.gen(function* () {
              const selected = ids.slice(0, linked);
              const { value, statements } = yield* counted(
                executor[sdk.AccountReadHost].listIds({ owner, ids: selected }),
              );
              assert.equal(statements.length, 4, JSON.stringify(statements));
              assert.deepEqual(
                value.map((account) => account.id),
                selected,
              );
              assert.deepEqual(
                value.map((account) => account.identity?.id),
                selected.map((id) => `aid_${id}`),
              );
            }),
          saved,
        ),
      );
    });

test("ID selection intersects owner, uses account-id order, and omits unresolved accounts", async () => {
  await Effect.runPromise(
    sdkFixture(
      ({ executor, owner, ids, foreign }) =>
        Effect.gen(function* () {
          const [first, second] = ids;
          const selected = yield* executor[sdk.AccountReadHost].listIds({
            owner,
            ids: [second!, foreign, first!, first!, sdk.AccountId.make("acc_missing")],
          });
          assert.deepEqual(
            selected.map((account) => account.id),
            [first, second],
          );
          const empty = yield* counted(executor[sdk.AccountReadHost].listIds({ owner, ids: [] }));
          assert.deepEqual(empty.value, []);
          assert.equal(empty.statements.length, 0);
          assert.equal((yield* executor.accounts.list({ owner })).length, ids.length);
          assert.deepEqual(
            yield* executor[sdk.AccountReadHost].listIds({ owner, ids: [foreign] }),
            [],
          );
        }),
      3,
    ),
  );
});

test("singleton and collection reads apply identical device execution policy", async () => {
  const calls: string[] = [];
  await Effect.runPromise(
    sdkFixture(
      ({ executor, owner, ids, sql }) =>
        Effect.gen(function* () {
          for (let i = 1; i < ids.length; i++)
            yield* sql`insert into executor_account_targets
          (account, owner, revision, mode, enabled, device, device_name, binding, manifest_revision)
          values (${ids[i]}, ${owner}, 1, ${i === 1 ? "cloud" : "device"}, ${i !== 2},
            'device', 'Named device', 'binding', 'manifest')`;
          const single = yield* Effect.forEach(ids, (account) =>
            executor.accounts.get({ owner, account }),
          );
          const singleCalls = [...calls];
          calls.length = 0;
          const listed = yield* counted(executor[sdk.AccountReadHost].listIds({ owner, ids }));
          assert.equal(listed.statements.length, 4);
          assert.deepEqual(listed.value, single);
          assert.deepEqual(calls, singleCalls);
          assert.deepEqual(
            listed.value.map((account) => account.execution?.status),
            [undefined, undefined, "disabled", "online", "offline", "unavailable", "unavailable"],
          );
          yield* sql`update executor_account_targets set revision = 0 where account = ${ids[3]}`;
          for (const read of [
            executor.accounts.get({ owner, account: ids[3]! }).pipe(Effect.asVoid),
            executor[sdk.AccountReadHost].listIds({ owner, ids }).pipe(Effect.asVoid),
          ]) {
            const result = yield* Effect.result(read);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") assert.equal(result.failure._tag, "StorageError");
          }
        }),
      7,
      {
        authorize: ({ account, managing }) =>
          Effect.sync(() => {
            calls.push(`authorize:${account}:${managing}`);
            return account !== "acc_005";
          }),
        availability: ({ account }) =>
          Effect.sync(() => {
            calls.push(`availability:${account}`);
            return account === "acc_004"
              ? "offline"
              : account === "acc_006"
                ? "unavailable"
                : "online";
          }),
      },
    ),
  );
});

test("device metadata stays unavailable without a machine host and storage failures propagate", async () => {
  await Effect.runPromise(
    sdkFixture(
      ({ executor, owner, ids, sql }) =>
        Effect.gen(function* () {
          yield* sql`insert into executor_account_targets
        (account, owner, revision, mode, enabled, device, device_name, binding, manifest_revision)
        values (${ids[0]}, ${owner}, 1, 'device', true, 'device', 'Named device', 'binding', 'manifest')`;
          const single = yield* executor.accounts.get({ owner, account: ids[0]! });
          const listed = yield* executor[sdk.AccountReadHost].listIds({ owner, ids });
          assert.deepEqual(listed, [single]);
          assert.equal(single.execution?.status, "unavailable");
          yield* sql`drop table executor_account_targets`;
          const result = yield* Effect.result(
            executor[sdk.AccountReadHost].listIds({ owner, ids }),
          );
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure._tag, "StorageError");
        }),
      1,
    ),
  );
});

test("public account listing ignores an undecoded internal ID filter", async () => {
  await Effect.runPromise(
    sdkFixture(
      ({ executor, owner, ids }) =>
        Effect.gen(function* () {
          const undecoded = { owner, ids: [ids[0]!] };
          assert.deepEqual(
            (yield* executor.accounts.list(undecoded)).map((account) => account.id),
            ids,
          );
          assert.deepEqual(
            (yield* executor[sdk.AccountReadHost].listIds(undecoded)).map((account) => account.id),
            [ids[0]],
          );
        }),
      3,
    ),
  );
});
