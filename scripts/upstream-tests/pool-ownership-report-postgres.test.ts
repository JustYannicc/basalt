import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PgClient } from "@effect/sql-pg";
import { Console, Effect, Exit, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import pg from "pg";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { reportHostPoolInventory } from "../../.upstream/apps/hosted/cloud/src/infrastructure/pool-inventory.ts";
import {
  poolOwnershipLine,
  readPoolPopulation,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/pool-ownership-report.ts";
import { postgresUrl } from "./org-lock-postgres-fixture.ts";

/** Every table the hourly inventory reads, with only the columns it reads, all as text. */
const tables = [
  "create table executor_accounts (id text, owner text, provider text, method text)",
  "create table hosted_account_access (account_id text, organization_id text, creator_id text, personal_user_id text, kind text, audience text, revision text)",
  "create table hosted_account_groups (organization_id text, account_id text, group_id text)",
  "create table hosted_app_access (id text, organization_id text, creator_id text, audience text, revision text)",
  "create table hosted_app_groups (organization_id text, app_id text, group_id text)",
  "create table hosted_groups (id text, organization_id text, revision text)",
  "create table hosted_group_members (group_id text, member_id text)",
  'create table member (id text, "organizationId" text, "userId" text, role text)',
  "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text)",
  "create table executor_account_connections (id text, owner text, provider text, reconnect_account text, revision text, state jsonb, target jsonb)",
  "create table hosted_connection_access (connection_id text, organization_id text, creator_id text, destination jsonb, target jsonb)",
  "create table executor_workflow_accounts (id text, account text, run text)",
  "create table executor_webhook_accounts (id text, account text, subscription text)",
  "create table executor_webhooks (id text, app text, owner text, source_account text, revision text)",
  "create table organization (id text primary key, metadata text)",
  "create table executor_apps (id text primary key, owner text, copied_from json)",
];
const source = "https://github.com/JustYannicc/basalt/tree/main/apps/pool";
// The catalog's copy and a person's default pool: the same source under two names.
const poolCopy = JSON.stringify({ reference: source, name: "basalt-pool", commit: null });
const defaultPool = JSON.stringify({ reference: source, name: "Basalt pool", commit: null });
const record = (...apps: string[]) =>
  JSON.stringify({
    secret: "never-in-a-line",
    basaltPools: Object.fromEntries(
      apps.map((app) => [app, { app, membership: "executor-links-v1" }]),
    ),
  });

async function withInventoryDatabase(
  work: (context: { admin: pg.Client; locker: pg.Client; schema: string }) => Promise<void>,
) {
  const url = postgresUrl();
  const schema = `inventory_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url });
  const locker = new pg.Client({ connectionString: url });
  await Promise.all([admin.connect(), locker.connect()]);
  try {
    await admin.query(`create schema ${schema}`);
    await admin.query(`set search_path = ${schema}`);
    for (const statement of tables) await admin.query(statement);
    await work({ admin, locker, schema });
  } finally {
    await locker.query("rollback").catch(() => {});
    await admin.query(`drop schema if exists ${schema} cascade`);
    await Promise.all([admin.end(), locker.end()]);
  }
}

const clientOn = (schema: string) =>
  ManagedRuntime.make(
    PgClient.layer({
      url: Redacted.make(postgresUrl()),
      maxConnections: 2,
      startupParameters: { search_path: schema },
      prepare: false,
    }),
  );

/** One run of the hourly job, with every line it writes. */
async function inventoryLines(schema: string) {
  const runtime = clientOn(schema);
  const lines: string[] = [];
  const captured: Console.Console = {
    ...globalThis.console,
    info: (...args) => void lines.push(args.join(" ")),
  };
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* reportHostPoolInventory.pipe(
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(Console.Console, captured),
        );
      }),
    );
  } finally {
    await runtime.dispose();
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The inventory's own lines, without what changes every run: its id, its snapshot, and the hash and size over it. */
const inventoryOnly = (
  lines: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> =>
  lines
    .filter((line) => line.inventory === "host-v1")
    .map(({ run: _run, sha256: _sha256, bytes: _bytes, data, ...line }) => ({
      ...line,
      data:
        typeof data === "string" ? JSON.parse(data.replace(/"snapshot":"[^"]*",/u, "")) : undefined,
    }));
const ownership = (lines: ReadonlyArray<Record<string, unknown>>) =>
  lines.filter((line) => line.inventory === "pool-ownership-v1");

test("the population report counts every pair a pool token can name by the check's own rule", async () => {
  await withInventoryDatabase(async ({ admin }) => {
    for (const [id, metadata] of [
      ["org_a", record("app_a")],
      // A record may name anything: it is classified as it stands, never validated.
      ["org_b", record("app_gone", "acceptance-pool")],
      ["org_c", record("app_c")],
      ["org_x", "{}"],
      ["org_d", "{}"],
      // Records whose app is not an id can match no pool a token names: no pair.
      [
        "org_e",
        JSON.stringify({ basaltPools: { n: { app: 5 }, o: { app: { x: 1 } }, e: { app: "" } } }),
      ],
    ])
      await admin.query("insert into organization values ($1, $2)", [id, metadata]);
    for (const [id, owner, copied] of [
      ["app_a", "organization:org_a", null],
      // Recorded by org_c, owned by org_x: foreign to the one, unrecorded for the other.
      ["app_c", "organization:org_x", null],
      // Pool apps no record names, found by their copy origin.
      ["app_p", "organization:org_d", poolCopy],
      ["app_q", "organization:org_gone", poolCopy],
      ["app_r", "organization:org_d", defaultPool],
      // A pool app no organization owns: no organization's token can name it.
      ["app_u", "user:someone", poolCopy],
      // Not a pool app and recorded by nobody: outside the population.
      [
        "app_other",
        "organization:org_a",
        JSON.stringify({ reference: "x", name: "basalt-pool", commit: null }),
      ],
    ])
      await admin.query("insert into executor_apps values ($1, $2, $3)", [id, owner, copied]);
    const lines = await inventoryLines(await schemaOf(admin));
    const [line] = ownership(lines);
    assert.ok(line, "the report wrote no line");
    assert.equal(line.complete, true);
    assert.equal(line.pairs, 8);
    assert.deepEqual(line.counts, {
      owned: 1,
      "organization-missing": 1,
      "deleted-pool": 2,
      "foreign-owner": 1,
      "no-record": 3,
      "invalid-metadata": 0,
    });
    // No read of the database can show these two; the line says so instead of counting 0.
    assert.deepEqual(line.notObservable, ["cleared-association", "other-organization"]);
    assert.deepEqual(
      new Set(
        (line.refusing as Array<{ pool: string; shape: string }>).map(
          (entry) => `${entry.pool} ${entry.shape}`,
        ),
      ),
      new Set([
        "app_gone deleted-pool",
        "acceptance-pool deleted-pool",
        "app_c foreign-owner",
        "app_c no-record",
        "app_p no-record",
        "app_r no-record",
      ]),
    );
    assert.equal(line.refusingOmitted, 0);
    assert.equal(line.invalidMetadataOrganizations, 0);
    // The line comes after the inventory's own end line, and never carries metadata.
    assert.equal(lines.at(-1), line);
    assert.equal(lines.at(-2)?.event, "end");
    assert.doesNotMatch(JSON.stringify(line), /never-in-a-line|basaltPools/u);
  });
});

test("the population read holds each organization's metadata once, however many pairs it has", async () => {
  await withInventoryDatabase(async ({ admin, schema }) => {
    const pools = Array.from({ length: 40 }, (_, index) => `app_${index}`);
    await admin.query("insert into organization values ('org_a', $1), ('org_b', $2)", [
      record(...pools),
      record("app_b"),
    ]);
    for (const pool of pools)
      await admin.query("insert into executor_apps values ($1, 'organization:org_a', null)", [
        pool,
      ]);
    const runtime = clientOn(schema);
    try {
      const facts = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* readPoolPopulation(yield* SqlClient.SqlClient);
        }),
      );
      assert.equal(facts.pairs.length, 41);
      assert.deepEqual(
        facts.pairs.filter((pair) => pair.metadata !== null).map((pair) => pair.organization),
        ["org_a", "org_b"],
      );
      // Each pair is still classified against its own organization's records.
      const line = JSON.parse(poolOwnershipLine(Exit.succeed(facts), "run", "snapshot"));
      assert.equal(line.counts.owned, 40);
      assert.equal(line.counts["deleted-pool"], 1);
      // Of the metadata, only its pool records are read.
      for (const pair of facts.pairs)
        assert.doesNotMatch(pair.metadata ?? "", /never-in-a-line|secret/u);
    } finally {
      await runtime.dispose();
    }
  });
});

test("the narrowed metadata classifies every pair as the whole metadata would, in any id order", async () => {
  await withInventoryDatabase(async ({ admin, schema }) => {
    // Ids whose order differs between collations pin that the read and its window order alike.
    const mixed = ["app_a", "app_B", "app-c", "App_d"];
    for (const [id, metadata] of [
      ["org_m", record(...mixed)],
      ["Org_n", record("app_n")],
      ["org-o", record("app_o")],
      ["org_missing", JSON.stringify({ other: 1 })],
      ["org_null", JSON.stringify({ basaltPools: null })],
      ["org_array", JSON.stringify(["basaltPools"])],
      ["org_text", "not json"],
    ])
      await admin.query("insert into organization values ($1, $2)", [id, metadata]);
    for (const [id, owner] of [
      ...mixed.map((pool) => [pool, "organization:org_m"]),
      ["app_n", "organization:Org_n"],
      ["app_o", "organization:org-o"],
      ["app_x", "organization:org_missing"],
      ["app_y", "organization:org_null"],
      ["app_z", "organization:org_array"],
    ])
      await admin.query("insert into executor_apps values ($1, $2, $3)", [id, owner, poolCopy]);
    const runtime = clientOn(schema);
    try {
      const facts = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* readPoolPopulation(yield* SqlClient.SqlClient);
        }),
      );
      const { rows } = await admin.query("select id, metadata from organization");
      const whole = new Map(rows.map((row) => [row.id as string, row.metadata as string | null]));
      // The same pairs with each organization's whole metadata on every row.
      const reference = {
        ...facts,
        pairs: facts.pairs.map((pair) => ({
          ...pair,
          metadata: whole.get(pair.organization) ?? null,
        })),
      };
      const line = (read: typeof facts) =>
        JSON.parse(poolOwnershipLine(Exit.succeed(read), "run", "snapshot"));
      assert.deepEqual(line(facts), line(reference));
      assert.equal(line(facts).counts.owned, 6);
      assert.equal(line(facts).counts["invalid-metadata"], 1);
    } finally {
      await runtime.dispose();
    }
  });
});

test("a report statement cancelled behind a lock leaves the inventory exactly as it is, and says so", async () => {
  await withInventoryDatabase(async ({ admin, locker, schema }) => {
    await admin.query("insert into organization values ('org_a', $1)", [record("app_a")]);
    await admin.query("insert into executor_apps values ('app_a', 'organization:org_a', null)");
    const free = await inventoryLines(schema);
    // A migration holds the apps table, which only the report reads.
    await locker.query("begin");
    await locker.query(`lock table ${schema}.executor_apps in access exclusive mode`);
    const locked = await inventoryLines(schema);
    await locker.query("rollback");
    assert.deepEqual(inventoryOnly(locked), inventoryOnly(free));
    assert.equal(inventoryOnly(locked).at(-1)?.complete, true);
    assert.deepEqual(
      ownership(locked).map(({ run: _run, snapshot: _snapshot, ...line }) => line),
      [
        {
          inventory: "pool-ownership-v1",
          complete: false,
          reason: "query_failed",
          migrationGo: false,
        },
      ],
    );
  });
});

test("above its row cap the report still writes an incomplete line", async () => {
  await withInventoryDatabase(async ({ admin, schema }) => {
    // A record without an app names no pair.
    await admin.query("insert into organization values ('org_a', $1)", [
      JSON.stringify({ basaltPools: { person: { membership: "executor-links-v1" } } }),
    ]);
    // Exactly 1,000 pool apps the organization owns and records nowhere: complete, 50 listed.
    for (let index = 0; index < 1_000; index++)
      await admin.query("insert into executor_apps values ($1, 'organization:org_a', $2)", [
        `app_${index}`,
        poolCopy,
      ]);
    const [full] = ownership(await inventoryLines(schema));
    assert.deepEqual(
      [full.complete, full.pairs, (full.refusing as unknown[]).length, full.refusingOmitted],
      [true, 1_000, 50, 950],
    );
    // Past it the read stops at its cap, while the inventory, which reads no apps, completes.
    for (const id of ["app_1000", "app_1001"])
      await admin.query("insert into executor_apps values ($1, 'organization:org_a', $2)", [
        id,
        poolCopy,
      ]);
    const capped = await inventoryLines(schema);
    assert.equal(inventoryOnly(capped).at(-1)?.complete, true);
    const [line] = ownership(capped);
    assert.deepEqual([line.complete, line.reason, line.pairs], [false, "row_cap", 1_001]);
    assert.equal(line.refusing, undefined);
  });
});

test("an inventory whose own read fails names why and where, and the report still covers every pair", async () => {
  await withInventoryDatabase(async ({ admin, locker, schema }) => {
    await admin.query("insert into organization values ('org_a', $1)", [record("app_a")]);
    await admin.query("insert into executor_apps values ('app_a', 'organization:org_a', null)");
    const failedWith = async () => {
      const lines = await inventoryLines(schema);
      const [end] = inventoryOnly(lines);
      const [line] = ownership(lines);
      // The report's line still comes last, and it is complete.
      assert.equal(lines.at(-1), line);
      assert.equal(line.complete, true);
      assert.equal((line.counts as { owned: number }).owned, 1);
      return { reason: end.reason, failure: end.failure, section: end.section };
    };
    // A section over the inventory's own row cap.
    for (let index = 0; index < 1_001; index++)
      await admin.query("insert into executor_accounts values ($1, 'o', 'p', 'm')", [
        `acc_${index}`,
      ]);
    assert.deepEqual(await failedWith(), {
      reason: "query_failed",
      failure: "row_cap",
      section: "accounts",
    });
    await admin.query("delete from executor_accounts");
    // A section the inventory waits for behind a lock past its own lock bound.
    await locker.query("begin");
    await locker.query(`lock table ${schema}.hosted_groups in access exclusive mode`);
    assert.deepEqual(await failedWith(), {
      reason: "query_failed",
      failure: "lock_timeout",
      section: "groups",
    });
    await locker.query("rollback");
    // A section the database cannot read at all.
    await admin.query(`drop table ${schema}.hosted_groups`);
    assert.deepEqual(await failedWith(), {
      reason: "query_failed",
      failure: "sql_error",
      section: "groups",
    });
    // And one that reads, with nothing failing: complete, no failure named.
    await admin.query(tables.find((statement) => statement.includes(" hosted_groups "))!);
    const lines = await inventoryLines(schema);
    assert.equal(inventoryOnly(lines).at(-1)?.complete, true);
    assert.equal(inventoryOnly(lines).at(-1)?.failure, undefined);
  });
});

test("metadata the database cannot read as JSON counts as invalid-metadata, and the line still holds no metadata", () => {
  const line = JSON.parse(
    poolOwnershipLine(
      Exit.succeed({
        pairs: [
          {
            organization: "org_a",
            pool: "app_a",
            metadata: "{ not json",
            valid: false,
            owner: "organization:org_a",
            present: true,
          },
        ],
        invalidMetadataOrganizations: 1,
      }),
      "run",
      "snapshot",
    ),
  );
  assert.equal(line.counts["invalid-metadata"], 1);
  assert.equal(line.invalidMetadataOrganizations, 1);
  assert.deepEqual(line.refusing, [{ pool: "app_a", shape: "invalid-metadata" }]);
  assert.doesNotMatch(JSON.stringify(line), /not json/u);
});

/** The schema the admin client's search path names. */
async function schemaOf(admin: pg.Client) {
  const { rows } = await admin.query("select current_schema() as schema");
  return rows[0].schema as string;
}
