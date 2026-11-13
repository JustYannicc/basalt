import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  openArtifact,
  ProtectedArtifact,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts";
import { retainedFrameworkObjects } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts";
import {
  bucketFixture,
  encoded,
  metadata,
  nativeObject,
  record,
} from "./retained-frameworks-fixture.ts";

// The runner uses its upstream typecheck configuration; this fixture decodes its public result.
interface Runner {
  readonly runProductionOperation: (
    input: typeof settings & {
      readonly retainedFrameworkObjects: ReturnType<typeof retainedFrameworkObjects>;
    },
    request: typeof operation,
  ) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>;
}
const runnerModule = process.env.BASALT_RETAINED_FRAMEWORK_RUNNER
  ? pathToFileURL(process.env.BASALT_RETAINED_FRAMEWORK_RUNNER).href
  : new URL(
      "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/runner.ts",
      import.meta.url,
    ).href;
const runner = (await import(runnerModule)) as Runner;
const recipient = generateKeyPairSync("rsa", { modulusLength: 3072 })
  .publicKey.export({ type: "spki", format: "der" })
  .toString("base64");
const identity = { version: "1.2.3", sha256: "a".repeat(64) };
const settings = {
  target: "https://operator.example.test",
  release: "fixture-release",
  databaseOrigin: { host: "fixture", port: 5432, database: "fixture" },
  encryptionKey: "ab".repeat(32),
  preparations: {},
};
const operation = {
  action: "inventory" as const,
  selection: "retained-frameworks",
  request: { organization: "org_one" },
  recipient,
};
const readonly = (sql: SqlClient.SqlClient) =>
  sql`select current_setting('transaction_read_only') as value`.pipe(
    Effect.map((rows) => rows[0]!.value),
  );
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table organization (id text primary key)`;
  yield* sql`create table hosted_organization_removal (organization_id text primary key)`;
  yield* sql`insert into organization values ('org_one')`;
  yield* sql`create table production_ops_database_identity (id uuid primary key)`;
  yield* sql`insert into production_ops_database_identity values ('11111111-1111-4111-8111-111111111111')`;
  yield* sql`create table executor_apps (id text primary key, code text, owner text, active_deployment text)`;
  yield* sql`create table executor_deployments (id text primary key, code text, owner text, build text)`;
  yield* sql`insert into executor_apps values
    ('app_one', 'code_one', 'organization:org_one', 'dpl_one'),
    ('app_copy', 'code_one', 'organization:org_one', 'dpl_two'),
    ('app_foreign', 'code_one', 'organization:org_other', 'dpl_foreign')`;
  yield* sql`insert into executor_deployments values
    ('dpl_one', 'code_one', 'organization:org_one', 'bld_one'),
    ('dpl_two', 'code_one', 'organization:org_one', 'bld_two'),
    ('dpl_foreign', 'code_one', 'organization:org_other', 'bld_foreign')`;
  return sql;
});
const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(work.pipe(Effect.provide(pgliteLayer()), Effect.scoped));

test("the actual runner closes SQL before R2 and resolves the captured inactive and copied associations", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* setup;
      const fixture = bucketFixture();
      fixture.objects.push(metadata(identity.version, identity.sha256));
      const list = fixture.bucket.list;
      fixture.bucket.list = (options) =>
        Effect.gen(function* () {
          assert.equal(
            yield* readonly(sql),
            "off",
            "SQL snapshot must close before the first R2 read",
          );
          yield* sql`update executor_deployments set build = 'bld_changed' where id = 'dpl_one'`;
          yield* sql`delete from executor_deployments where id = 'dpl_two'`;
          return yield* list(options);
        });
      fixture.bodies.set("bld_one/worker.json", encoded(record(identity)));
      fixture.bodies.set("bld_two/worker.json", encoded(record(identity)));
      const result = yield* runner
        .runProductionOperation(
          { ...settings, retainedFrameworkObjects: retainedFrameworkObjects(fixture.bucket) },
          operation,
        )
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Struct({ artifact: ProtectedArtifact })),
          ),
        );
      const value = yield* Effect.promise(() =>
        openArtifact(result.artifact, settings.encryptionKey, settings.target),
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              complete: Schema.Boolean,
              builds: Schema.Array(
                Schema.Struct({
                  build: Schema.String,
                  apps: Schema.Array(Schema.String),
                  deployments: Schema.Array(Schema.String),
                }),
              ),
            }),
          ),
        ),
      );
      assert.equal(value.complete, true);
      assert.deepEqual(fixture.reads, ["bld_one/worker.json", "bld_two/worker.json"]);
      assert.deepEqual(value.builds, [
        { build: "bld_one", apps: ["app_copy", "app_one"], deployments: ["dpl_one"] },
        { build: "bld_two", apps: ["app_copy", "app_one"], deployments: ["dpl_two"] },
      ]);
      assert.equal(yield* readonly(sql), "off");
      assert.equal(fixture.writes(), 0);
    }),
  );
});

test("SQL failures and scope refusals start no R2 work", async () => {
  for (const failure of ["query", "removing", "references"] as const)
    await run(
      Effect.gen(function* () {
        const sql = yield* setup;
        const fixture = bucketFixture();
        if (failure === "query") yield* sql`drop table executor_deployments`;
        else if (failure === "removing")
          yield* sql`insert into hosted_organization_removal values ('org_one')`;
        else
          yield* sql`insert into executor_deployments
        select 'dpl_extra_' || n, 'code_one', 'organization:org_one', 'bld_extra_' || n from generate_series(1, 1000) as n`;
        const exit = yield* runner
          .runProductionOperation(
            { ...settings, retainedFrameworkObjects: retainedFrameworkObjects(fixture.bucket) },
            operation,
          )
          .pipe(Effect.exit);
        assert.ok(Exit.isFailure(exit));
        assert.deepEqual(fixture.lists, []);
        assert.deepEqual(fixture.reads, []);
        assert.equal(yield* readonly(sql), "off");
      }),
    );
});

test("R2 timeout and cancellation leave no SQL transaction open", async () => {
  for (const cancel of [false, true])
    await run(
      Effect.gen(function* () {
        const sql = yield* setup;
        const fixture = bucketFixture();
        const started = Promise.withResolvers<void>();
        let cancelled = 0;
        let gets = 0;
        fixture.bucket.get = () =>
          Effect.sync(() => {
            gets++;
            return nativeObject(
              1,
              new ReadableStream<Uint8Array>(
                {
                  pull() {
                    started.resolve();
                  },
                  cancel() {
                    cancelled++;
                    return new Promise<void>(() => {});
                  },
                },
                { highWaterMark: 0 },
              ),
            );
          });
        fixture.bucket.list = () =>
          Effect.gen(function* () {
            assert.equal(yield* readonly(sql), "off");
            return { objects: [], truncated: false };
          });
        const fiber = yield* runner
          .runProductionOperation(
            { ...settings, retainedFrameworkObjects: retainedFrameworkObjects(fixture.bucket) },
            operation,
          )
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        if (cancel) yield* Fiber.interrupt(fiber);
        else yield* TestClock.adjust("25 seconds");
        const exit = yield* Fiber.await(fiber);
        assert.ok(Exit.isFailure(exit));
        assert.equal(yield* readonly(sql), "off");
        assert.equal(cancelled, gets);
        assert.equal(gets, cancel ? 2 : 4);
      }).pipe(Effect.provide(TestClock.layer())),
    );
});
