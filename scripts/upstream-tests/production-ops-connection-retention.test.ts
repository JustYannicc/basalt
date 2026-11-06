import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const hour = 3_600_000;
const settings = {
  target: "https://ops.fixture",
  release: "fixture-release",
  databaseOrigin: { host: "fixture", port: 5432, database: "fixture" },
  encryptionKey: "ab".repeat(32),
  preparations: {},
};

/**
 * Two organizations' connections, each with its sign-in attempt and access row. `expired` is hours
 * since expiry; negative is still live.
 */
const seeded = [
  { id: "conn_own_pending_old", org: "org_own", status: "pending", expired: 72 },
  { id: "conn_own_cancelled_old", org: "org_own", status: "cancelled", expired: 48 },
  {
    id: "conn_own_pending_no_attempt",
    org: "org_own",
    status: "pending",
    expired: 30,
    attempt: false,
  },
  { id: "conn_own_completed_old", org: "org_own", status: "completed", expired: 72 },
  { id: "conn_own_pending_fresh", org: "org_own", status: "pending", expired: 1 },
  { id: "conn_own_cancelled_fresh", org: "org_own", status: "cancelled", expired: 10 },
  { id: "conn_own_pending_live", org: "org_own", status: "pending", expired: -0.3 },
  { id: "conn_other_pending_old", org: "org_other", status: "pending", expired: 72 },
  { id: "conn_other_completed_old", org: "org_other", status: "completed", expired: 72 },
];
const removedByMigration = [
  "conn_own_cancelled_old",
  "conn_own_pending_no_attempt",
  "conn_own_pending_old",
];

const fixture = Effect.gen(function* () {
  const [sdk, resources, opsSchema] = yield* Effect.promise(() =>
    Promise.all([
      load("packages/sdk/src/core.ts"),
      load("apps/hosted/server/src/implementation/resource-schema.ts"),
      load("apps/hosted/cloud/src/infrastructure/production-ops/schema.ts"),
    ]),
  );
  const sql = yield* SqlClient.SqlClient;
  const storage = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
  yield* storage.migrate;
  yield* sql`create table organization (id text primary key, name text, metadata text)`;
  yield* sql`create table "user" (id text primary key)`;
  yield* sql`create table hosted_groups (organization_id text, id text)`;
  yield* sql`create table hosted_organization_removal (organization_id text primary key)`;
  yield* resources.migrateResourceAccess;
  yield* opsSchema.migrateProductionOps;
  yield* opsSchema.migrateProductionOpsDatabaseIdentity;
  yield* sql`insert into "user" values ('usr_fixture')`;
  for (const org of ["org_own", "org_other"])
    yield* sql`insert into organization values (${org}, ${org}, '{}')`;
  const now = Date.now();
  for (const row of seeded) {
    const owner = `organization:${row.org}`;
    const attempt = row.attempt === false ? null : `attempt_${row.id}`;
    const expires = new Date(now - row.expired * hour);
    if (attempt !== null)
      yield* sql`insert into executor_oauth_attempts (id, encrypted, expires_at, status)
        values (${attempt}, ${new Uint8Array([1, 2, 3])}, ${expires}, 'pending')`;
    const state =
      row.status === "completed"
        ? { status: "completed", account: { id: "acc" } }
        : { status: row.status };
    yield* sql`insert into executor_account_connections
      (id, owner, provider, reconnect_account, state, revision, oauth_attempt, created_at, expires_at, target)
      values (${row.id}, ${owner}, 'prv_fixture', null, ${JSON.stringify(state)}, 'r1', ${attempt},
        ${new Date(expires.getTime() - 30 * 60_000)}, ${expires},
        ${JSON.stringify({ app: "app_fixture", requirement: "service", name: "Fixture", owner, scope: "user" })})`;
    yield* sql`insert into hosted_connection_access (connection_id, organization_id, creator_id, destination)
      values (${row.id}, ${row.org}, 'usr_fixture', '{}'::jsonb)`;
  }
  const ids = (table: string, column: string) =>
    sql
      .unsafe(`select ${column} as id from ${table} order by 1`)
      .pipe(Effect.map((rows) => rows.map((row) => String((row as { id: unknown }).id))));
  return {
    sql,
    connections: ids("executor_account_connections", "id"),
    attempts: ids("executor_oauth_attempts", "id"),
    access: ids("hosted_connection_access", "connection_id"),
  };
});

const refusal = (operation: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
  Effect.flip(operation).pipe(Effect.map((error) => (error as { message?: string }).message));
const without = (all: readonly string[], removed: readonly string[]) =>
  all.filter((id) => !removed.includes(id)).sort();
const attemptsOf = (connections: readonly string[]) =>
  connections
    .filter((id) => id !== "conn_own_pending_no_attempt")
    .map((id) => `attempt_${id}`)
    .sort();
const allConnections = seeded.map((row) => row.id).sort();

const run = (work: Effect.Effect<void, unknown, unknown>) =>
  Effect.runPromise(
    Effect.scoped(work.pipe(Effect.provide(pgliteLayer()))) as Effect.Effect<void, unknown>,
  );

test("account connection retention removes exactly the reviewed abandoned connections, attempts first", async () => {
  const [runner, migrations, crypto] = await Promise.all([
    load("apps/hosted/cloud/src/infrastructure/production-ops/runner.ts"),
    load("apps/hosted/cloud/src/infrastructure/production-ops/migrations.ts"),
    load("apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts"),
  ]);
  assert.ok(
    Object.hasOwn(migrations.productionMigrations, "account-connection-retention-v1"),
    "The migration is registered",
  );
  const keys = await webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const recipient = Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey)).toString(
    "base64",
  );
  await run(
    Effect.gen(function* () {
      const { sql, connections, attempts, access } = yield* fixture;
      const request = {
        organization: "org_own",
        expiredBefore: new Date(Date.now() - 24 * hour - 60_000).toISOString(),
      };
      const operation = (action: string, extra: object = {}, body = request) =>
        runner.runProductionOperation(settings, {
          action,
          selection: "account-connection-retention-v1",
          request: body,
          recipient,
          ...extra,
        });
      // A cutoff newer than a day refuses; it could include connections that may still complete.
      assert.equal(
        yield* refusal(
          operation(
            "dry-run",
            {},
            { ...request, expiredBefore: new Date(Date.now() - hour).toISOString() },
          ),
        ),
        "The cutoff must be at least 24 hours old",
      );

      const dry = yield* operation("dry-run");
      const plan = (yield* Effect.promise(() =>
        crypto.openArtifact(dry.artifact, settings.encryptionKey, settings.target),
      )) as { plan: { changes: unknown[] } };
      const changes = plan.plan.changes as {
        table: string;
        key: Record<string, string>;
        action: string;
      }[];
      const planned = changes
        .filter((change) => change.table === "executor_account_connections")
        .map((change) => change.key.id)
        .sort();
      assert.deepEqual(
        planned,
        removedByMigration,
        "The dry run lists exactly the abandoned connections",
      );
      assert.ok(changes.every((change) => change.action === "delete"));
      // Each connection's attempt and access row come before it.
      for (const id of removedByMigration) {
        const at = (table: string, key: string) =>
          changes.findIndex(
            (change) => change.table === table && Object.values(change.key).includes(key),
          );
        const connection = at("executor_account_connections", id);
        assert.ok(at("hosted_connection_access", id) < connection, `access before ${id}`);
        if (id !== "conn_own_pending_no_attempt")
          assert.ok(
            at("executor_oauth_attempts", `attempt_${id}`) < connection,
            `attempt before ${id}`,
          );
      }
      assert.equal(changes.length, removedByMigration.length * 3 - 1);
      // The backup holds the full rows of every candidate and its attempt.
      const backup = (yield* Effect.promise(() =>
        crypto.openArtifact(dry.backup, settings.encryptionKey, settings.target),
      )) as { rows: Record<string, unknown[]> };
      for (const id of removedByMigration)
        assert.ok(JSON.stringify(backup.rows.executor_account_connections).includes(id));
      assert.ok(
        JSON.stringify(backup.rows.executor_oauth_attempts).includes(
          "attempt_conn_own_pending_old",
        ),
      );

      const apply = (go = `GO ${dry.artifact.sha256}`) =>
        operation("apply", {
          artifact: dry.artifact,
          planSha256: dry.artifact.sha256,
          backupSha256: dry.backupSha256,
          go,
        });
      assert.equal(
        yield* refusal(apply("GO wrong")),
        "Apply requires the reviewed plan hash and exact GO",
      );
      // A reviewed row that changed refuses, and nothing is removed.
      yield* sql`update executor_account_connections set revision = 'r2' where id = 'conn_own_cancelled_old'`;
      assert.equal(yield* refusal(apply()), "Migration inputs changed after review");
      assert.deepEqual(yield* connections, allConnections);
      yield* sql`update executor_oauth_attempts set status = 'cancelled' where id = 'attempt_conn_own_pending_old'`;
      yield* sql`update executor_account_connections set revision = 'r1' where id = 'conn_own_cancelled_old'`;
      assert.equal(yield* refusal(apply()), "Migration inputs changed after review");
      yield* sql`update executor_oauth_attempts set status = 'pending' where id = 'attempt_conn_own_pending_old'`;

      const applied = yield* apply();
      assert.equal(applied.repeated, false);
      assert.equal(applied.verification.ok, true);
      const kept = without(allConnections, removedByMigration);
      assert.deepEqual(
        yield* connections,
        kept,
        "Completed, fresh and other-organization rows stay",
      );
      assert.deepEqual(
        yield* attempts,
        attemptsOf(kept),
        "Exactly the removed attempts, none orphaned",
      );
      assert.deepEqual(yield* access, kept);
      const orphans = yield* sql`select id from executor_oauth_attempts a where not exists
        (select 1 from executor_account_connections c where c.oauth_attempt = a.id)`;
      assert.deepEqual(orphans, []);

      const repeated = yield* apply();
      assert.equal(repeated.repeated, true, "A repeat apply replays its receipt");
      assert.equal(repeated.verification.ok, true);
      assert.deepEqual(yield* connections, kept);
    }),
  );
});

test("the daily connection retention rule is off by default and applies the same predicate when on", async () => {
  const [retention, inventory] = await Promise.all([
    load("apps/hosted/server/src/implementation/connection-retention.ts"),
    load("apps/hosted/cloud/src/infrastructure/production-ops/inventory.ts"),
  ]);
  const enabled = (env: Record<string, string>) =>
    Effect.runPromise(
      retention.connectionRetentionEnabled.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      ) as Effect.Effect<boolean>,
    );
  assert.equal(await enabled({}), false, "No setting means off");
  assert.equal(await enabled({ EXECUTOR_ACCOUNT_CONNECTION_RETENTION: "true" }), true);
  await run(
    Effect.gen(function* () {
      const { connections, attempts, access } = yield* fixture;
      assert.equal(yield* retention.retainConnections(false), 0);
      assert.deepEqual(yield* connections, allConnections, "Off removes nothing");
      // The inventory's own definitions select what the rule must remove.
      const expected: string[] = [];
      for (const org of ["org_own", "org_other"]) {
        const { rows } = yield* inventory.inventory("connections", org);
        for (const row of rows as { id: string; produced_account: boolean; expires_at: string }[])
          if (
            !row.produced_account &&
            Date.parse(row.expires_at.replace(" ", "T").replace(/\+00$/u, "Z")) <
              Date.now() - 24 * hour
          )
            expected.push(row.id);
      }
      expected.sort();
      assert.deepEqual(expected, [...removedByMigration, "conn_other_pending_old"].sort());
      assert.equal(yield* retention.retainConnections(true), expected.length);
      const kept = without(allConnections, expected);
      assert.deepEqual(yield* connections, kept);
      assert.deepEqual(yield* attempts, attemptsOf(kept));
      assert.deepEqual(yield* access, kept);
      assert.equal(yield* retention.retainConnections(true), 0, "A second run finds nothing");
    }),
  );
});
