import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { CurrentTransformer } from "effect/sql/Statement";
import { AccessLifecycle } from "../../.upstream/apps/hosted/server/src/contracts/access-lifecycle.ts";
import { poolAccessLifecycle } from "../../.upstream/apps/hosted/server/src/implementation/pool-access-hook.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { app, organization, postgresFixture } from "./org-lock-postgres-fixture.ts";
import { nativeRead, runtime, seed } from "./pool-membership-query-fixture.ts";

const key = "ab".repeat(32);
const lifecycle = poolAccessLifecycle(
  Option.some(Redacted.make(key)),
  "https://pool.example.invalid",
);
const Snapshot = Schema.Struct({ native: Schema.Boolean, accounts: Schema.Array(Schema.Unknown) });
const registration = (statement: string) =>
  statement.includes("from organization o") &&
  statement.includes("jsonb_each") &&
  statement.includes("join executor_apps app");
const native = { app, membership: "executor-links-v1" };
const cases = [
  { name: "native", records: { fixture: native }, native: true },
  { name: "non-pool", records: {}, native: false },
  { name: "absent app", records: { fixture: { ...native, app: "app_absent" } }, native: false },
  { name: "inactive legacy", records: { fixture: { app } }, inactive: true, native: false },
  { name: "wrong app owner", records: { fixture: native }, wrongOwner: true, native: false },
  {
    name: "another organization",
    records: { fixture: native },
    otherOrganization: true,
    native: false,
  },
];

for (const item of cases) {
  test(`one fresh registration statement for ${item.name} membership`, async () => {
    await postgresFixture(({ sql }) =>
      Effect.gen(function* () {
        yield* seed({ accounts: 1, hosted: true });
        yield* sql`update organization set metadata=${JSON.stringify({ basaltPools: item.records })} where id=${organization}`;
        if (item.inactive)
          yield* sql`update executor_apps set active_deployment=null where id=${app}`;
        if (item.wrongOwner)
          yield* sql`update executor_apps set owner='organization:other' where id=${app}`;
        if (item.otherOrganization) {
          yield* sql`insert into organization values ('org_other',${JSON.stringify({ basaltPools: item.records })})`;
          yield* sql`update organization set metadata='{}' where id=${organization}`;
        }
        const { executor } = runtime(sql);
        const statements: string[] = [];
        const result = yield* nativeRead(executor).pipe(
          Effect.provideService(CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
        );
        assert.equal(result.native, item.native);
        assert.equal(result.accounts.length, item.native ? 1 : 0);
        const lookups = statements.filter(registration);
        assert.equal(lookups.length, 1, `${item.name} must read registration once`);
        const lock = statements.findIndex((statement) =>
          statement.includes("pg_advisory_xact_lock("),
        );
        assert.ok(
          lock >= 0 && lock < statements.findIndex(registration),
          "the organization access lock precedes registration",
        );
      }),
    );
  });
}

test("legacy registration uses the signed handoff, rereads its transition and stays fresh", async () => {
  await postgresFixture(({ sql, locks }) =>
    Effect.gen(function* () {
      yield* seed({ accounts: 1, hosted: true });
      const legacy = JSON.stringify({ basaltPools: { fixture: { app } } });
      yield* sql`update organization set metadata=${legacy} where id=${organization}`;
      const delivered: unknown[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).pathname, "/pool/v1/membership");
        const body = await request.json();
        const value = await openEnvelope(key, "sbm1", body.envelope);
        delivered.push(value);
        assert.ok((await Effect.runPromise(locks)).some((lock) => lock.granted));
        return new Response(null, { status: 204 });
      };
      const { executor } = runtime(sql);
      const read = nativeRead(executor).pipe(
        Effect.provideService(AccessLifecycle, lifecycle),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
      );
      assert.equal((yield* read).native, true);
      assert.equal(delivered.length, 1);
      assert.deepEqual(
        Schema.decodeUnknownSync(
          Schema.Struct({ pool: Schema.String, organization: Schema.String }),
        )(delivered[0]),
        { pool: app, organization },
      );
      assert.equal((yield* read).native, true);
      assert.equal(delivered.length, 1, "steady native reads do not repeat the handoff");
      yield* sql`update organization set metadata='{}' where id=${organization}`;
      assert.equal((yield* read).native, false, "registration removal is visible on the next read");
      assert.equal(delivered.length, 1);
    }),
  );
});

test("legacy handoff refusal rolls back registration and permits a fresh retry", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ accounts: 1, hosted: true });
      const legacy = JSON.stringify({ basaltPools: { fixture: { app } } });
      yield* sql`update organization set metadata=${legacy} where id=${organization}`;
      let status = 503;
      let calls = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls++;
        return new Response(null, { status });
      };
      const { executor } = runtime(sql);
      const read = nativeRead(executor).pipe(
        Effect.provideService(AccessLifecycle, lifecycle),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
      );
      assert.equal((yield* Effect.result(read))._tag, "Failure");
      assert.deepEqual(yield* sql`select metadata from organization where id=${organization}`, [
        { metadata: legacy },
      ]);
      assert.equal(calls, 1);
      status = 204;
      assert.equal((yield* read).native, true);
      assert.equal(calls, 2);
    }),
  );
});

test("duplicate native registrations work while mixed metadata retains handoff refusal", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ accounts: 1, hosted: true });
      const { executor } = runtime(sql);
      const read = nativeRead(executor).pipe(
        Effect.provideService(AccessLifecycle, lifecycle),
        Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
      );
      yield* sql`update organization set metadata=${JSON.stringify({ basaltPools: { one: native, two: native } })} where id=${organization}`;
      assert.equal((yield* read).native, true);
      const mixed = JSON.stringify({ basaltPools: { one: native, two: { app } } });
      yield* sql`update organization set metadata=${mixed} where id=${organization}`;
      assert.equal((yield* Effect.result(read))._tag, "Failure");
      assert.deepEqual(yield* sql`select metadata from organization where id=${organization}`, [
        { metadata: mixed },
      ]);
    }),
  );
});

test("an absent optional lifecycle cannot manufacture native authority", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed({ accounts: 1, hosted: true });
      const { executor } = runtime(sql);
      yield* sql`update organization set metadata=${JSON.stringify({ basaltPools: { fixture: { app } } })} where id=${organization}`;
      const result = yield* nativeRead(executor).pipe(
        Effect.provideService(AccessLifecycle, {}),
        Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
      );
      assert.equal(result.native, false);
      assert.deepEqual(result.accounts, []);
    }),
  );
});
