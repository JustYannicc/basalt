import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { postgresFixture } from "./org-lock-postgres-fixture.ts";
import { nativeRead, runtime, sdk, seed } from "./pool-membership-query-fixture.ts";

test("native membership does not upgrade SDK row locks through a second connection", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ accounts: 6, hosted: true });
      const [{ pid: policyPid }] = yield* sql<{ pid: number }>`select pg_backend_pid() as pid`;
      const { executor: base } = runtime(sql);
      const host = base[sdk.AccountAcquisitionHost];
      const source = host.source;
      const executor = {
        ...base,
        [sdk.AccountAcquisitionHost]: {
          source: (input: Parameters<typeof source>[0]) =>
            source(input).pipe(
              Effect.map((resolved) => ({
                ...resolved,
                // SDK storage and hosted policy can have independent transaction contexts.
                current: Effect.tryPromise(() =>
                  Effect.runPromise(
                    sql.withTransaction(
                      Effect.gen(function* () {
                        const [{ pid }] = yield* sql<{
                          pid: number;
                        }>`select pg_backend_pid() as pid`;
                        assert.notEqual(pid, policyPid);
                        yield* sql`set local lock_timeout='250ms'`;
                        yield* sql`update executor_accounts set owner=owner where id=${input.account}`;
                        yield* sql`update executor_account_acquisitions set revision=revision
                      where account=${input.account} and revision=${resolved.binding.revision}`;
                        return resolved.binding;
                      }),
                    ),
                  ),
                ),
              })),
            ),
        },
      };
      const result = yield* nativeRead(executor);
      assert.equal(result.accounts.length, 6);
      assert.ok(result.accounts.every((account) => account.homeReference !== null));
    }),
  );
});

test("native membership refuses stale acquisition bindings under the locked snapshot", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ accounts: 1, hosted: true });
      const { executor } = runtime(sql);
      const source = executor[sdk.AccountAcquisitionHost].source;
      const stale = [
        { account: sdk.AccountId.make("acc_other") },
        { owner: sdk.OwnerId.make("organization:other") },
        { provider: sdk.ProviderId.make("prv_other") },
        { method: "other" },
        { generation: 0 },
        { driver: "other" },
        { driverRevision: "driver-old" },
        { revision: "binding-old" },
        { removal: { operation: "removed", removed: true } },
      ];
      for (const changed of stale) {
        const candidate = {
          ...executor,
          [sdk.AccountAcquisitionHost]: {
            source: (input: Parameters<typeof source>[0]) =>
              source(input).pipe(
                Effect.map((resolved) => ({
                  ...resolved,
                  binding: { ...resolved.binding, ...changed },
                })),
              ),
          },
        };
        const result = yield* nativeRead(candidate);
        assert.equal(result.accounts.length, 1);
        assert.equal(result.accounts[0]?.homeReference, null, JSON.stringify(changed));
      }
    }),
  );
});

test("native membership drops revoked and removed accounts and resolves rebound references afresh", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ accounts: 1, hosted: true });
      const { executor } = runtime(sql);
      const initial = yield* nativeRead(executor);
      assert.equal(initial.accounts[0]?.homeReference, "fixture-reference-binding-one");
      yield* sql`update executor_account_acquisitions set revision='binding-two'
        where account='acc_membership_000'`;
      const rebound = yield* nativeRead(executor);
      assert.equal(rebound.accounts[0]?.bindingRevision, "binding-two");
      assert.equal(rebound.accounts[0]?.homeReference, "fixture-reference-binding-two");
      yield* sql`update executor_account_acquisitions set removal='{"operation":"removed"}'::jsonb
        where account='acc_membership_000'`;
      assert.deepEqual((yield* nativeRead(executor)).accounts, []);
      yield* sql`update executor_account_acquisitions set removal=null
        where account='acc_membership_000'`;
      yield* sql`delete from hosted_account_access where account_id='acc_membership_000'`;
      assert.deepEqual((yield* nativeRead(executor)).accounts, []);
    }),
  );
});
