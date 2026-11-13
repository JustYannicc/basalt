import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { retainedFrameworkObjects } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts";
import { ProtectedArtifact } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts";
import { diagnostic } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/diagnostics.ts";
import { retainedInventory } from "../production-ops/inventory-pagination.ts";
import { canonical, decryptArtifact, hash } from "../production-ops/artifact.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { bucketFixture, encoded, metadata, record } from "./retained-frameworks-fixture.ts";

const Operation = Schema.Struct({
  action: Schema.Literal("inventory"),
  selection: Schema.String,
  request: Schema.Struct({ organization: Schema.String }),
  recipient: Schema.String,
  continuation: Schema.optionalKey(ProtectedArtifact),
});
const settings = {
  target: "https://operator.example.test",
  release: "fixture-release",
  databaseOrigin: { host: "fixture", port: 5432, database: "fixture" },
  encryptionKey: "ab".repeat(32),
  preparations: {},
};
interface Runner {
  readonly runProductionOperation: (
    opsSettings: typeof settings & {
      retainedFrameworkObjects: ReturnType<typeof retainedFrameworkObjects>;
    },
    operation: typeof Operation.Type,
  ) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>;
}
const runner = (await import(
  new URL(
    "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/runner.ts",
    import.meta.url,
  ).href
)) as Runner;
const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
const recipient = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const input = {
  ...settings,
  signingKey: "ab".repeat(32),
  action: "inventory",
  mode: "dry-run",
  selection: "retained-frameworks",
  request: '{"organization":"org_one"}',
  recipient,
  planSha256: "",
  go: "",
};
const identity = { version: "1.2.3", sha256: "a".repeat(64) };
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table organization (id text primary key)`;
  yield* sql`insert into organization values ('org_one'),('org_other')`;
  yield* sql`create table hosted_organization_removal (organization_id text primary key)`;
  yield* sql`create table production_ops_database_identity (id uuid primary key)`;
  yield* sql`insert into production_ops_database_identity values ('11111111-1111-4111-8111-111111111111')`;
  yield* sql`create table executor_apps (id text primary key, code text, owner text, active_deployment text)`;
  yield* sql`create table executor_deployments (id text primary key, code text, owner text, build text)`;
  yield* sql`insert into executor_apps values ('app_one','code_one','organization:org_one',null),('app_copy','code_one','organization:org_one',null),('app_foreign','code_one','organization:org_other',null)`;
  yield* sql`insert into executor_deployments select 'dpl_'||n,'code_one','organization:org_one','bld_'||lpad(n::text,4,'0') from generate_series(1,329)n`;
  yield* sql`insert into executor_deployments values ('dpl_foreign','code_one','organization:org_other','bld_foreign')`;
  const fixture = bucketFixture();
  fixture.objects.push(metadata(identity.version, identity.sha256));
  for (let i = 1; i <= 329; i++)
    fixture.bodies.set(`bld_${String(i).padStart(4, "0")}/worker.json`, encoded(record(identity)));
  return { sql, fixture };
});
const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(work.pipe(Effect.provide(pgliteLayer()), Effect.scoped));
const Inventory = Schema.Struct({
  format: Schema.Literal("basalt-production-inventory-v1"),
  complete: Schema.Boolean,
  builds: Schema.Array(
    Schema.Struct({
      build: Schema.String,
      apps: Schema.Array(Schema.String),
      deployments: Schema.Array(Schema.String),
    }),
  ),
  rows: Schema.Array(
    Schema.Struct({
      version: Schema.String,
      sha256: Schema.String,
      protocol: Schema.Number,
      apps: Schema.Array(Schema.String),
      deployments: Schema.Number,
    }),
  ),
});

function transport(
  sql: SqlClient.SqlClient,
  fixture: ReturnType<typeof bucketFixture>,
  change?: (index: number) => Promise<void>,
) {
  let calls = 0;
  const results: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const index = calls++;
    await change?.(index);
    const raw = Schema.decodeUnknownSync(Schema.Struct({ operation: Operation }))(
      await openEnvelope(input.signingKey, "sbops1", JSON.parse(String(init!.body)).envelope),
    );
    const operation = Schema.decodeUnknownSync(Operation)(raw.operation);
    const response = await Effect.runPromise(
      runner
        .runProductionOperation(
          { ...settings, retainedFrameworkObjects: retainedFrameworkObjects(fixture.bucket) },
          operation,
        )
        .pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.timeout("25 seconds"),
          Effect.matchCause({
            onFailure: (cause) =>
              Response.json({ failure: diagnostic(cause, "sql") }, { status: 409 }),
            onSuccess: (value) => {
              results.push(value);
              return Response.json(value);
            },
          }),
        ),
    );
    return response;
  };
  return { fetcher, results, calls: () => calls };
}

test("the real SQL runner pages copied and inactive deployments and the operator decrypts one complete inventory", async () =>
  run(
    Effect.gen(function* () {
      const { sql, fixture } = yield* setup;
      const get = fixture.bucket.get;
      fixture.bucket.get = (key) =>
        Effect.gen(function* () {
          const state = yield* sql`select current_setting('transaction_read_only') as value`;
          assert.equal(state[0]!.value, "off");
          return yield* get(key);
        });
      const t = transport(sql, fixture);
      const result = yield* Effect.promise(() => retainedInventory(input, t.fetcher));
      const value = Schema.decodeUnknownSync(Inventory)(
        JSON.parse(decryptArtifact(result.artifact, privateKey, settings.target)),
      );
      assert.equal(result.pages, 6);
      assert.equal(result.builds, 329);
      assert.equal(result.references, 658);
      assert.equal(value.complete, true);
      assert.equal(value.builds.length, 329);
      assert.equal(value.rows.length, 1);
      assert.equal(value.rows[0]!.deployments, 329);
      for (const build of value.builds) assert.deepEqual(build.apps, ["app_copy", "app_one"]);
      assert.equal(fixture.reads.length, 329);
      assert.equal(new Set(fixture.reads).size, 329);
      assert.ok(!fixture.reads.some((k) => k.includes("foreign")));
      assert.equal(fixture.writes(), 0);
      for (const pages of [
        result.artifact.pages.slice(0, -1),
        [...result.artifact.pages].reverse(),
        result.artifact.pages.filter((_page, index) => index !== 2),
      ])
        assert.throws(() =>
          decryptArtifact(
            { ...result.artifact, pages, sha256: hash(canonical(pages)) },
            privateKey,
            settings.target,
          ),
        );
    }),
  ));

test("changed references fail closed at the final page without repeating earlier builds", async () =>
  run(
    Effect.gen(function* () {
      const { sql, fixture } = yield* setup;
      const t = transport(sql, fixture, async (index) => {
        if (index === 1)
          await Effect.runPromise(
            sql`update executor_deployments set build='bld_changed' where id='dpl_1'`,
          );
      });
      const exit = yield* Effect.promise(() => retainedInventory(input, t.fetcher)).pipe(
        Effect.exit,
      );
      assert.equal(exit._tag, "Failure");
      assert.equal(t.calls(), 6);
      assert.equal(fixture.reads.length, 320);
      assert.equal(new Set(fixture.reads).size, 320);
    }),
  ));

test("continuation tampering, organization and release changes refuse before record reads", async () =>
  run(
    Effect.gen(function* () {
      const { fixture } = yield* setup;
      const operation = {
        action: "inventory" as const,
        selection: "retained-frameworks",
        request: { organization: "org_one" },
        recipient,
      };
      const first = yield* runner
        .runProductionOperation(
          { ...settings, retainedFrameworkObjects: retainedFrameworkObjects(fixture.bucket) },
          operation,
        )
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Struct({ continuation: ProtectedArtifact })),
          ),
        );
      const before = fixture.reads.length;
      for (const changed of [
        {
          settings,
          operation: {
            ...operation,
            request: { organization: "org_other" },
            continuation: first.continuation,
          },
        },
        {
          settings: { ...settings, release: "different" },
          operation: { ...operation, continuation: first.continuation },
        },
        {
          settings,
          operation: {
            ...operation,
            continuation: {
              ...first.continuation,
              sealed: { ...first.continuation.sealed, ciphertext: "broken" },
            },
          },
        },
      ]) {
        const exit = yield* runner
          .runProductionOperation(
            {
              ...changed.settings,
              retainedFrameworkObjects: retainedFrameworkObjects(fixture.bucket),
            },
            changed.operation,
          )
          .pipe(Effect.exit);
        assert.equal(exit._tag, "Failure");
        assert.equal(fixture.reads.length, before);
      }
    }),
  ));
