import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Redacted, Schema } from "effect";
import { CurrentTransformer } from "effect/sql/Statement";
import { app, organization, postgresFixture, until } from "./org-lock-postgres-fixture.ts";
import {
  home,
  membership,
  nativeRead,
  owner,
  provider,
  runtime,
  sdk,
  seed,
} from "./pool-membership-query-fixture.ts";

const requirements = {
  accounts: Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      index === 0 ? "models" : `unused${index}`,
      {
        scope: "app",
        provider,
        cardinality: "many",
        contributed: true,
        definition: {
          name: `Service ${index}`,
          auth: {
            key: {
              type: "secrets",
              label: "Key",
              fields: {
                type: "object",
                description: "Synthetic provider instructions. ".repeat(140),
              },
            },
          },
        },
      },
    ]),
  ),
};

test("large JSON membership bounds declaration buffer work on the steady read", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ requirements, hosted: true });
      const { executor } = runtime(sql);
      yield* nativeRead(executor);
      let final: readonly [string, readonly unknown[]] | undefined;
      yield* nativeRead(executor).pipe(
        Effect.provideService(CurrentTransformer, (statement) =>
          Effect.sync(() => {
            const compiled = statement.compile();
            if (compiled[0].includes('as "requirementScope"')) final = compiled;
            return statement;
          }),
        ),
      );
      assert.ok(final);
      const explain = yield* sql.unsafe(
        `explain (analyze, buffers, format json) ${final[0]}`,
        final[1],
      );
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            "QUERY PLAN": Schema.Array(
              Schema.Struct({
                Plan: Schema.Struct({
                  "Actual Rows": Schema.Number,
                  "Shared Hit Blocks": Schema.Number,
                  "Shared Read Blocks": Schema.Number,
                }),
              }),
            ),
          }),
        ),
      )(explain);
      const plan = decoded[0]?.["QUERY PLAN"][0]?.Plan;
      assert.ok(plan);
      assert.equal(plan["Actual Rows"], 32);
      const blocks = plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
      console.log(
        JSON.stringify({
          membershipRows: 32,
          declarationBytes: Buffer.byteLength(JSON.stringify(requirements)),
          bufferBlocks: blocks,
        }),
      );
      assert.ok(blocks < 700, `32-account declaration read used ${blocks} shared buffer blocks`);
    }),
  );
});

test("large JSON declarations keep exact reference fingerprints and fresh activation", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(sdk.AppRequirements)(requirements);
      yield* seed({ requirements, hosted: true });
      const { executor, reads } = runtime(sql);
      yield* Effect.tryPromise(() =>
        membership.bindPoolMembershipReferenceRuntime(executor, {}, Redacted.make("fixture-key")),
      );
      const first = yield* nativeRead(executor);
      assert.equal(first.accounts.length, 32);
      assert.deepEqual(yield* nativeRead(executor), first);
      assert.equal(reads(), 32);
      yield* sql`insert into executor_deployments values ('dpl_same_declaration',${JSON.stringify(requirements)})`;
      yield* sql`update executor_apps set active_deployment='dpl_same_declaration' where id=${app}`;
      assert.deepEqual(yield* nativeRead(executor), first);
      assert.equal(
        reads(),
        32,
        "equal fingerprint inputs reuse their validated reference across activation",
      );
      yield* sql`update executor_accounts set encrypted_credentials=decode('02','hex') where id=${home}`;
      assert.deepEqual(yield* nativeRead(executor), first);
      assert.equal(reads(), 64, "a changed ciphertext digest requires reference validation");
      yield* sql`update executor_deployments set requirements=${JSON.stringify({ accounts: { models: { scope: "user", provider } } })} where id='dpl_same_declaration'`;
      assert.deepEqual((yield* nativeRead(executor)).accounts, []);
      yield* sql`update executor_apps set active_deployment='dpl_membership_query' where id=${app}`;
      assert.deepEqual((yield* nativeRead(executor)).accounts, first.accounts);
    }),
  );
});

test("projected contribution policy preserves audience revocation and exact departure timestamps", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ requirements, hosted: true });
      const { executor } = runtime(sql);
      assert.equal((yield* nativeRead(executor)).accounts.length, 32);
      yield* sql`update hosted_account_access set audience='groups' where account_id=${home}`;
      assert.equal((yield* nativeRead(executor)).accounts.length, 31);
      yield* sql`update hosted_account_access set audience='everyone' where account_id=${home}`;
      yield* sql`insert into hosted_contributed_departure_jobs (id,organization_id,user_id) values ('departure',${organization},'owner')`;
      yield* sql`insert into hosted_contributed_departures select 'departure',app,requirement,account,created_at from hosted_app_account_links where account=${home}`;
      assert.equal((yield* nativeRead(executor)).accounts.length, 31);
      yield* sql`update hosted_app_account_links set created_at=created_at + interval '1 second' where account=${home}`;
      assert.equal(
        (yield* nativeRead(executor)).accounts.length,
        32,
        "an old departure cannot revoke a newer link",
      );
      yield* sql`update executor_accounts set owner='organization:other' where id=${home}`;
      assert.equal((yield* nativeRead(executor)).accounts.length, 31);
      yield* sql`update executor_accounts set owner=${owner} where id=${home}`;
      yield* sql`update hosted_account_access set kind='personal',personal_user_id='departed' where account_id=${home}`;
      assert.equal((yield* nativeRead(executor)).accounts.length, 31);
    }),
  );
});

test("absent and non-object declaration fields keep empty membership rather than enumeration errors", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ hosted: true });
      const { executor } = runtime(sql);
      for (const value of [
        null,
        {},
        { accounts: null },
        { accounts: [] },
        { accounts: "invalid" },
        { accounts: { models: null } },
      ]) {
        yield* sql`update executor_deployments set requirements=${JSON.stringify(value)} where id='dpl_membership_query'`;
        assert.deepEqual((yield* nativeRead(executor)).accounts, []);
      }
      yield* sql`update executor_apps set active_deployment=null where id=${app}`;
      assert.deepEqual((yield* nativeRead(executor)).accounts, []);
    }),
  );
});

test("the final declaration read observes activation committed while account locks are waiting", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ requirements, hosted: true });
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select id from executor_accounts where id=${home} for update`;
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );
      yield* Deferred.await(locked);
      const { executor } = runtime(sql);
      const read = yield* Effect.forkChild(nativeRead(executor));
      yield* until(
        sql<{ count: number }>`select count(*)::int as count from pg_stat_activity
      where datname=current_database() and application_name=current_setting('application_name')
        and wait_event_type='Lock' and query like 'select a.id from hosted_app_account_links%'`,
        (rows) => rows[0]?.count === 1,
      );
      yield* sql`insert into executor_deployments values ('dpl_activated_while_waiting',${JSON.stringify({ accounts: { models: { scope: "user", provider } } })})`;
      yield* sql`update executor_apps set active_deployment='dpl_activated_while_waiting' where id=${app}`;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      assert.deepEqual((yield* Fiber.join(read)).accounts, []);
    }),
  );
});
