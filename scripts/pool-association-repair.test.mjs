import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { Cause, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { PgliteClient } from "../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pglite/dist/index.js";
import { runProductionOperation } from "../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/runner.ts";
import { openArtifact } from "../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts";

const recipient = generateKeyPairSync("rsa", { modulusLength: 3072 })
  .publicKey.export({ type: "spki", format: "der" })
  .toString("base64");
const settings = {
  target: "https://fixture.invalid",
  release: "fixture-release",
  databaseOrigin: { host: "fixture.invalid", port: 5432, database: "template1" },
  encryptionKey: "ab".repeat(32),
  preparations: {},
};
const operation = (request) => ({
  action: "dry-run",
  selection: "pool-association-repair-v1",
  request: { organization: "org_fixture", ...request },
  recipient,
});
const fixture = (work) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const statement of `create table organization(id text primary key, metadata text);
    create table hosted_organization_removal(organization_id text);
    create table executor_apps(id text primary key, owner text, code text, active_deployment text);
    create table executor_deployments(id text primary key, owner text, code text);
    create table hosted_app_access(id text primary key, organization_id text, creator_id text);
    create table production_ops_database_identity(id uuid);
    insert into production_ops_database_identity values ('00000000-0000-4000-8000-000000000001');
    create table private_production_ops_receipts(plan_sha256 text primary key, organization_id text, migration text, revision text, release text, backup_sha256 text, verification jsonb);`
        .split(";")
        .filter((part) => part.trim()))
        yield* sql.unsafe(statement);
      yield* sql`insert into organization values ('org_fixture', ${JSON.stringify({ keep: { untouched: true }, basaltPools: { user_fixture: { app: "app_missing", version: "dpl_retained", owner: "user_fixture", authorization: "executor-app-v1" }, other: { app: "app_other", version: "dpl_other" } } })})`;
      return yield* work;
    }).pipe(Effect.provide(PgliteClient.layer({}))),
  );

test("reviewed clear plan removes only the exact stale registration and replay does not write again", async () => {
  await fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const input = operation({
        slot: "user_fixture",
        app: "app_missing",
        actualOwner: null,
        operation: "clear",
      });
      const before = yield* sql`select metadata from organization where id = 'org_fixture'`;
      const dry = yield* runProductionOperation(settings, input);
      assert.ok(dry.action === "dry-run");
      assert.deepEqual(
        yield* sql`select metadata from organization where id = 'org_fixture'`,
        before,
      );
      assert.equal(dry.changes, 1);
      const apply = {
        ...input,
        action: "apply",
        artifact: dry.artifact,
        backupSha256: dry.backupSha256,
        planSha256: dry.artifact.sha256,
        go: `GO ${dry.artifact.sha256}`,
      };
      const applied = yield* runProductionOperation(settings, apply);
      assert.ok(applied.action === "apply");
      assert.equal(applied.repeated, false);
      const rows = yield* sql`select metadata from organization where id = 'org_fixture'`;
      assert.deepEqual(JSON.parse(rows[0].metadata), {
        keep: { untouched: true },
        basaltPools: { other: { app: "app_other", version: "dpl_other" } },
      });
      const replay = yield* runProductionOperation(settings, apply);
      assert.ok(replay.action === "apply");
      assert.equal(replay.repeated, true);
      assert.equal((yield* sql`select * from private_production_ops_receipts`).length, 1);
    }),
  );
});

test("apply refuses changed pointer, unrelated metadata, owner or app existence without a receipt", async () => {
  for (const drift of ["pointer", "metadata", "owner", "appeared"]) {
    await fixture(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (drift === "owner")
          yield* sql`insert into executor_apps values ('app_missing', 'organization:foreign', 'code_old', null)`;
        const input = operation({
          slot: "user_fixture",
          app: "app_missing",
          actualOwner: drift === "owner" ? "organization:foreign" : null,
          operation: "clear",
        });
        const dry = yield* runProductionOperation(settings, input);
        assert.ok(dry.action === "dry-run");
        if (drift === "pointer")
          yield* sql`update organization set metadata = jsonb_set(metadata::jsonb, '{basaltPools,user_fixture,app}', '"app_changed"')::text where id = 'org_fixture'`;
        if (drift === "metadata")
          yield* sql`update organization set metadata = jsonb_set(metadata::jsonb, '{keep,untouched}', 'false')::text where id = 'org_fixture'`;
        if (drift === "owner")
          yield* sql`update executor_apps set owner = 'user:changed' where id = 'app_missing'`;
        if (drift === "appeared")
          yield* sql`insert into executor_apps values ('app_missing', 'organization:org_fixture', 'code_new', null)`;
        const before = yield* sql`select * from organization`;
        const result = yield* runProductionOperation(settings, {
          ...input,
          action: "apply",
          artifact: dry.artifact,
          backupSha256: dry.backupSha256,
          planSha256: dry.artifact.sha256,
          go: `GO ${dry.artifact.sha256}`,
        }).pipe(Effect.result);
        assert.equal(result._tag, "Failure", drift);
        assert.deepEqual(yield* sql`select * from organization`, before);
        assert.equal((yield* sql`select * from private_production_ops_receipts`).length, 0);
      }),
    );
  }
});

test("clear requires the exact invalid reference and preserves foreign app rows", async () => {
  await fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into executor_apps values ('app_missing', 'organization:foreign', 'code_old', null)`;
      for (const request of [
        {
          slot: "wrong",
          app: "app_missing",
          actualOwner: "organization:foreign",
          operation: "clear",
        },
        {
          slot: "user_fixture",
          app: "wrong",
          actualOwner: "organization:foreign",
          operation: "clear",
        },
        { slot: "user_fixture", app: "app_missing", actualOwner: null, operation: "clear" },
      ])
        assert.equal(
          (yield* runProductionOperation(settings, operation(request)).pipe(Effect.result))._tag,
          "Failure",
        );
      const before = yield* sql`select * from executor_apps`;
      const input = operation({
        slot: "user_fixture",
        app: "app_missing",
        actualOwner: "organization:foreign",
        operation: "clear",
      });
      const dry = yield* runProductionOperation(settings, input);
      assert.ok(dry.action === "dry-run");
      const plan = yield* Effect.tryPromise(() =>
        openArtifact(dry.artifact, settings.encryptionKey, settings.target),
      );
      assert.ok(JSON.stringify(plan).includes('"actualOwner":"organization:foreign"'));
      yield* runProductionOperation(settings, {
        ...input,
        action: "apply",
        artifact: dry.artifact,
        backupSha256: dry.backupSha256,
        planSha256: dry.artifact.sha256,
        go: `GO ${dry.artifact.sha256}`,
      });
      assert.deepEqual(yield* sql`select * from executor_apps`, before);
    }),
  );
});

test("repoint preserves policy only with exact existing replacement provenance and no stale credentials", async () => {
  await fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into executor_apps values ('app_replacement', 'organization:org_fixture', 'code_pool', 'dpl_retained')`;
      yield* sql`insert into executor_deployments values ('dpl_retained', 'organization:org_fixture', 'code_pool')`;
      yield* sql`insert into hosted_app_access values ('app_replacement', 'org_fixture', 'user_fixture')`;
      const input = operation({
        slot: "user_fixture",
        app: "app_missing",
        actualOwner: null,
        operation: "repoint",
        replacement: "app_replacement",
      });
      const dry = yield* runProductionOperation(settings, input);
      assert.ok(dry.action === "dry-run");
      yield* runProductionOperation(settings, {
        ...input,
        action: "apply",
        artifact: dry.artifact,
        backupSha256: dry.backupSha256,
        planSha256: dry.artifact.sha256,
        go: `GO ${dry.artifact.sha256}`,
      });
      const rows = yield* sql`select metadata from organization where id = 'org_fixture'`;
      assert.deepEqual(JSON.parse(rows[0].metadata).basaltPools.user_fixture, {
        app: "app_replacement",
        version: "dpl_retained",
        owner: "user_fixture",
        authorization: "executor-app-v1",
      });
    }),
  );
});

test("repoint refuses existing old app, credential ambiguity, mismatched creator/version and duplicate target", async () => {
  for (const invalid of [
    "old-app",
    "account",
    "token-key",
    "creator",
    "version",
    "lineage",
    "duplicate",
  ]) {
    await fixture(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`insert into executor_apps values ('app_replacement', 'organization:org_fixture', 'code_pool', 'dpl_retained')`;
        yield* sql`insert into executor_deployments values ('dpl_retained', 'organization:org_fixture', 'code_pool')`;
        yield* sql`insert into hosted_app_access values ('app_replacement', 'org_fixture', 'user_fixture')`;
        if (invalid === "old-app")
          yield* sql`insert into executor_apps values ('app_missing', 'organization:foreign', 'code_old', null)`;
        if (invalid === "account")
          yield* sql`update organization set metadata=jsonb_set(metadata::jsonb,'{basaltPools,user_fixture,account}','"acct_old"')::text`;
        if (invalid === "token-key")
          yield* sql`update organization set metadata=jsonb_set(metadata::jsonb,'{basaltPools,user_fixture,tokenKeyVersion}','"old"')::text`;
        if (invalid === "creator")
          yield* sql`update hosted_app_access set creator_id = 'user_other'`;
        if (invalid === "version")
          yield* sql`update executor_apps set active_deployment = 'dpl_changed'`;
        if (invalid === "lineage") yield* sql`update executor_deployments set code = 'code_other'`;
        if (invalid === "duplicate")
          yield* sql`update organization set metadata=jsonb_set(metadata::jsonb,'{basaltPools,other,app}','"app_replacement"')::text`;
        const result = yield* runProductionOperation(
          settings,
          operation({
            slot: "user_fixture",
            app: "app_missing",
            actualOwner: invalid === "old-app" ? "organization:foreign" : null,
            operation: "repoint",
            replacement: "app_replacement",
          }),
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure", invalid);
        assert.equal((yield* sql`select * from private_production_ops_receipts`).length, 0);
      }),
    );
  }
});

test("closed repair refusals survive the runtime and operator boundary", async () => {
  const { diagnostic } =
    await import("../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/diagnostics.ts");
  const { PoolAssociationRepairRefused, poolAssociationRepairReasons } =
    await import("../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/migrations/pool-association-repair-v1.ts");
  const { poolAssociationRepairReasons: operatorReasons } =
    await import("./production-ops/pool-association-repair-reasons.ts");
  const { failureReceipt } = await import("./production-ops/failure.ts");
  assert.deepEqual(operatorReasons, poolAssociationRepairReasons);
  for (const reasonCode of poolAssociationRepairReasons) {
    const receipt = diagnostic(Cause.fail(new PoolAssociationRepairRefused({ reasonCode })), "sql");
    assert.equal(failureReceipt(receipt)?.reasonCode, reasonCode);
  }
  assert.equal(
    failureReceipt({
      format: "basalt-production-ops-failure-v1",
      category: "refused",
      phase: "sql",
      reasonCode: "credential=never-retain-secret",
    })?.reasonCode,
    undefined,
  );
});

test("repair preserves exact large numbers outside the selected pointer", async () => {
  await fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
        '{unrelatedLarge}', '9007199254740993123456789'::jsonb)::text where id = 'org_fixture'`;
      const input = operation({
        slot: "user_fixture",
        app: "app_missing",
        actualOwner: null,
        operation: "clear",
      });
      const dry = yield* runProductionOperation(settings, input);
      assert.ok(dry.action === "dry-run");
      yield* runProductionOperation(settings, {
        ...input,
        action: "apply",
        artifact: dry.artifact,
        backupSha256: dry.backupSha256,
        planSha256: dry.artifact.sha256,
        go: `GO ${dry.artifact.sha256}`,
      });
      const rows =
        yield* sql`select metadata::jsonb ->> 'unrelatedLarge' as exact from organization where id = 'org_fixture'`;
      assert.equal(rows[0].exact, "9007199254740993123456789");
    }),
  );
});
