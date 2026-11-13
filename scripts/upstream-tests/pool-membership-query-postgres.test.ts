import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Redacted } from "effect";
import { CurrentTransformer } from "effect/sql/Statement";
import { app, postgresFixture, until } from "./org-lock-postgres-fixture.ts";
import { home, membership, nativeRead, runtime, seed } from "./pool-membership-query-fixture.ts";

test("native membership evaluates policy once on PostgreSQL and refreshes exact references", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed();
      const { executor, reads } = runtime(sql);
      yield* Effect.tryPromise(() =>
        membership.bindPoolMembershipReferenceRuntime(executor, {}, Redacted.make("fixture-key")),
      );
      const first = yield* nativeRead(executor);
      assert.equal(first.accounts.length, 32);
      assert.equal(first.accounts[0].homeReference, "fixture-reference-binding-one");
      const statements: string[] = [];
      const cached = yield* nativeRead(executor).pipe(
        Effect.provideService(CurrentTransformer, (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile()[0]);
            return statement;
          }),
        ),
      );
      assert.deepEqual(cached, first);
      assert.equal(reads(), 32);
      const policyReads = statements.filter(
        (sql) => sql.includes("hosted_app_account_links") && sql.includes("hosted_account_access"),
      );
      console.log(
        JSON.stringify({
          accounts: 32,
          statements: statements.length,
          policyJoins: policyReads.length,
        }),
      );
      assert.equal(policyReads.length, 1, "one fresh policy evaluation per native membership read");

      yield* sql`update executor_account_acquisitions set revision='binding-two' where account=${home}`;
      const changed = yield* nativeRead(executor);
      assert.equal(changed.accounts[0].bindingRevision, "binding-two");
      assert.equal(changed.accounts[0].homeReference, "fixture-reference-binding-two");
      assert.equal(reads(), 64);
      yield* sql`delete from hosted_account_access where account_id=${home}`;
      const revoked = yield* nativeRead(executor);
      assert.equal(
        revoked.accounts.some((row: { account: string }) => row.account === home),
        false,
      );
      assert.equal(revoked.accounts.length, 31);
      yield* sql`delete from hosted_app_account_links where app=${app}`;
      assert.deepEqual((yield* nativeRead(executor)).accounts, []);
    }),
  );
});

test("native membership keeps account and binding locks until reference validation finishes", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed();
      const arrived = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = Deferred.succeed(arrived, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const { executor } = runtime(sql, held);
      const read = yield* Effect.forkChild(nativeRead(executor));
      yield* Deferred.await(arrived);
      const accountWrite = yield* Effect.forkChild(
        sql`update executor_accounts set credential_generation=2 where id=${home}`,
      );
      const bindingWrite = yield* Effect.forkChild(
        sql`update executor_account_acquisitions set revision='binding-two' where account=${home}`,
      );
      yield* until(
        sql<{
          count: number;
        }>`select count(*)::int as count from pg_stat_activity where datname=current_database()
          and application_name=current_setting('application_name') and wait_event_type='Lock'
          and query like 'update executor_%'`,
        (rows) => rows[0]?.count === 2,
      );
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(read);
      assert.equal(result.accounts[0].generation, 1);
      assert.equal(result.accounts[0].bindingRevision, "binding-one");
      yield* Fiber.join(accountWrite);
      yield* Fiber.join(bindingWrite);
      const [account] = yield* sql<{
        credential_generation: number;
      }>`select credential_generation from executor_accounts where id=${home}`;
      const [binding] = yield* sql<{
        revision: string;
      }>`select revision from executor_account_acquisitions where account=${home}`;
      assert.equal(account?.credential_generation, 2);
      assert.equal(binding?.revision, "binding-two");
    }),
  );
});
