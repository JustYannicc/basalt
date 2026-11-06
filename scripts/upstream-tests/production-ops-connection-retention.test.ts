import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { ConfigProvider, Effect, Schema } from "effect";
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
const migration = "account-connection-retention-v1";

interface Seed {
  readonly id: string;
  readonly org: string;
  readonly status: string;
  /** Hours since expiry; negative is still live. */
  readonly expired: number;
  /** The sign-in attempt it names; `null` names none. Defaults to its own. */
  readonly attempt?: string | null;
}

/** Two organizations' connections, each with its sign-in attempt and access row. */
const seeded: readonly Seed[] = [
  { id: "conn_own_pending_old", org: "org_own", status: "pending", expired: 72 },
  { id: "conn_own_cancelled_old", org: "org_own", status: "cancelled", expired: 48 },
  {
    id: "conn_own_pending_no_attempt",
    org: "org_own",
    status: "pending",
    expired: 30,
    attempt: null,
  },
  { id: "conn_own_completed_old", org: "org_own", status: "completed", expired: 72 },
  { id: "conn_own_pending_fresh", org: "org_own", status: "pending", expired: 1 },
  { id: "conn_own_cancelled_fresh", org: "org_own", status: "cancelled", expired: 10 },
  { id: "conn_own_pending_live", org: "org_own", status: "pending", expired: -0.3 },
  { id: "conn_other_pending_old", org: "org_other", status: "pending", expired: 72 },
  { id: "conn_other_completed_old", org: "org_other", status: "completed", expired: 72 },
];
const abandoned = (rows: readonly Seed[]) =>
  rows
    .filter((row) => row.status !== "completed" && row.expired > 24)
    .map((row) => row.id)
    .sort();
const removedByMigration = abandoned(seeded.filter((row) => row.org === "org_own"));
const attemptOf = (row: Seed) => (row.attempt === undefined ? `attempt_${row.id}` : row.attempt);

const fixture = (rows: readonly Seed[]) =>
  Effect.gen(function* () {
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
    const attempts = new Set<string>();
    for (const row of rows) {
      const owner = `organization:${row.org}`;
      const attempt = attemptOf(row);
      const expires = new Date(now - row.expired * hour);
      if (attempt !== null && !attempts.has(attempt)) {
        attempts.add(attempt);
        yield* sql`insert into executor_oauth_attempts (id, encrypted, expires_at, status)
          values (${attempt}, ${new Uint8Array([1, 2, 3])}, ${expires}, 'pending')`;
      }
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
      sql.unsafe(`select ${column} as id from ${table} order by 1`).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String }))),
        ),
        Effect.map((found) => found.map((row) => row.id)),
      );
    return {
      sql,
      connections: ids("executor_account_connections", "id"),
      attempts: ids("executor_oauth_attempts", "id"),
      access: ids("hosted_connection_access", "connection_id"),
    };
  });

const without = (all: readonly string[], removed: readonly string[]) =>
  all.filter((id) => !removed.includes(id)).sort();
const attemptsOf = (connections: readonly string[]) =>
  seeded
    .filter((row) => connections.includes(row.id))
    .flatMap((row) => {
      const attempt = attemptOf(row);
      return attempt === null ? [] : [attempt];
    })
    .sort();
const allConnections = seeded.map((row) => row.id).sort();
const Refused = Schema.Struct({ message: Schema.String });
const refusal = (operation: Effect.Effect<unknown, unknown, unknown>) =>
  Effect.flip(operation).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Refused)),
    Effect.map((error) => error.message),
  );
const Plan = Schema.Struct({
  plan: Schema.Struct({
    changes: Schema.Array(
      Schema.Struct({
        table: Schema.String,
        key: Schema.Record(Schema.String, Schema.String),
        action: Schema.String,
      }),
    ),
  }),
});
const Backup = Schema.Struct({ rows: Schema.Record(Schema.String, Schema.Array(Schema.Json)) });

const run = (work: Effect.Effect<void, unknown, unknown>) =>
  Effect.runPromise(
    Effect.scoped(work.pipe(Effect.provide(pgliteLayer()))) as Effect.Effect<void, unknown>,
  );

/** Signed operations through the runner, as the production-ops route dispatches them. */
const operations = async () => {
  const [runner, migrations, crypto] = await Promise.all([
    load("apps/hosted/cloud/src/infrastructure/production-ops/runner.ts"),
    load("apps/hosted/cloud/src/infrastructure/production-ops/migrations.ts"),
    load("apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts"),
  ]);
  assert.ok(
    Object.hasOwn(migrations.productionMigrations, migration),
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
  const cutoff = new Date(Date.now() - 24 * hour - 60_000).toISOString();
  const request = { organization: "org_own", expiredBefore: cutoff };
  const operation = (action: string, extra: object = {}, body: object = request) =>
    runner.runProductionOperation(settings, {
      action,
      selection: migration,
      request: body,
      recipient,
      ...extra,
    });
  const open = <S extends Schema.Top>(schema: S, artifact: unknown) =>
    Effect.promise(() =>
      crypto.openArtifact(artifact, settings.encryptionKey, settings.target),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
  return { request, operation, open };
};

test("account connection retention removes exactly the reviewed abandoned connections, attempts first", async () => {
  const { request, operation, open } = await operations();
  await run(
    Effect.gen(function* () {
      const { sql, connections, attempts, access } = yield* fixture(seeded);
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
      const { changes } = (yield* open(Plan, dry.artifact)).plan;
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
      const backup = yield* open(Backup, dry.backup);
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
      // Every change to a reviewed row after the dry run refuses, and nothing is removed.
      const changed = "Migration inputs changed after review";
      for (const [change, restore, message] of [
        [
          sql`update executor_account_connections set revision = 'r2' where id = 'conn_own_cancelled_old'`,
          sql`update executor_account_connections set revision = 'r1' where id = 'conn_own_cancelled_old'`,
          changed,
        ],
        [
          sql`update executor_oauth_attempts set status = 'cancelled' where id = 'attempt_conn_own_pending_old'`,
          sql`update executor_oauth_attempts set status = 'pending' where id = 'attempt_conn_own_pending_old'`,
          changed,
        ],
        // Completing the sign-in takes it out of the selection.
        [
          sql`update executor_account_connections set state = '{"status":"completed","account":{"id":"acc"}}' where id = 'conn_own_pending_old'`,
          sql`update executor_account_connections set state = '{"status":"pending"}' where id = 'conn_own_pending_old'`,
          changed,
        ],
        // A reconnect account outside the organization fails the scope check first.
        [
          sql`update executor_account_connections set reconnect_account = 'acc_elsewhere' where id = 'conn_own_pending_old'`,
          sql`update executor_account_connections set reconnect_account = null where id = 'conn_own_pending_old'`,
          "Migration row is outside the selected organization",
        ],
      ] as const) {
        yield* change;
        assert.equal(yield* refusal(apply()), message);
        assert.deepEqual(yield* connections, allConnections);
        assert.deepEqual(yield* attempts, attemptsOf(allConnections));
        yield* restore;
      }

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

test("account connection retention refuses a shared sign-in attempt and more than one plan's bound", async () => {
  const { operation } = await operations();
  const old = { org: "org_own", status: "pending", expired: 72 };
  // Another connection, even a live one, still names the attempt.
  await run(
    Effect.gen(function* () {
      const { connections } = yield* fixture([
        { ...old, id: "conn_shared_old", attempt: "attempt_shared" },
        { ...old, id: "conn_shared_live", expired: -0.3, attempt: "attempt_shared" },
      ]);
      assert.equal(yield* refusal(operation("dry-run")), "A sign-in attempt is shared");
      assert.deepEqual(yield* connections, ["conn_shared_live", "conn_shared_old"]);
    }),
  );
  // Above the plan bound, and above the row reads' own bound, the operator gets the same advice.
  for (const length of [201, 1001])
    await run(
      Effect.gen(function* () {
        yield* fixture(
          Array.from({ length }, (_, index) => ({
            ...old,
            id: `conn_bulk_${String(index).padStart(4, "0")}`,
            attempt: null,
          })),
        );
        assert.equal(
          yield* refusal(operation("dry-run")),
          "More than 200 connections; choose an earlier cutoff",
        );
      }),
    );
});

test("the daily connection retention rule is off by default and applies the same predicate when on", async () => {
  const [retention, inventory] = await Promise.all([
    load("apps/hosted/server/src/implementation/connection-retention.ts"),
    load("apps/hosted/cloud/src/infrastructure/production-ops/inventory.ts"),
  ]);
  // Off, the caller's work never starts: no database connection and no scheduled loop.
  const gated = async (env: Record<string, string>) => {
    let started = false;
    const ran = await Effect.runPromise(
      retention
        .whenConnectionRetentionEnabled(Effect.sync(() => (started = true)))
        .pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        ) as Effect.Effect<boolean>,
    );
    return { ran, started };
  };
  assert.deepEqual(await gated({}), { ran: false, started: false }, "No setting means off");
  assert.deepEqual(await gated({ EXECUTOR_ACCOUNT_CONNECTION_RETENTION: "false" }), {
    ran: false,
    started: false,
  });
  assert.deepEqual(await gated({ EXECUTOR_ACCOUNT_CONNECTION_RETENTION: "true" }), {
    ran: true,
    started: true,
  });
  const shared: Seed[] = [
    // An abandoned connection whose attempt a live connection still names.
    {
      id: "conn_own_shared_old",
      org: "org_own",
      status: "pending",
      expired: 72,
      attempt: "attempt_shared",
    },
    {
      id: "conn_own_shared_live",
      org: "org_own",
      status: "pending",
      expired: -0.3,
      attempt: "attempt_shared",
    },
  ];
  const all = [...seeded, ...shared];
  const InventoryRow = Schema.Struct({ id: Schema.String, produced_account: Schema.Boolean });
  await run(
    Effect.gen(function* () {
      const { connections, attempts, access } = yield* fixture(all);
      // The inventory's own `produced_account` decides which connections never produced one.
      const unproduced = new Set<string>();
      for (const org of ["org_own", "org_other"]) {
        const { rows } = yield* inventory.inventory("connections", org);
        for (const row of yield* Schema.decodeUnknownEffect(Schema.Array(InventoryRow))(rows))
          if (!row.produced_account) unproduced.add(row.id);
      }
      const expected = abandoned(all);
      assert.deepEqual(
        expected,
        all
          .filter((row) => unproduced.has(row.id) && row.expired > 24)
          .map((row) => row.id)
          .sort(),
      );
      assert.equal(yield* retention.retainConnections, expected.length);
      const kept = without(
        all.map((row) => row.id),
        expected,
      );
      assert.deepEqual(yield* connections, kept);
      assert.deepEqual(yield* access, kept);
      const keptAttempts = [
        ...new Set(
          all
            .filter((row) => kept.includes(row.id))
            .flatMap((row) => {
              const attempt = attemptOf(row);
              return attempt === null ? [] : [attempt];
            }),
        ),
      ].sort();
      assert.ok(
        keptAttempts.includes("attempt_shared"),
        "A shared attempt stays with its live connection",
      );
      assert.deepEqual(yield* attempts, keptAttempts);
      assert.equal(yield* retention.retainConnections, 0, "A second run finds nothing");
    }),
  );
});
