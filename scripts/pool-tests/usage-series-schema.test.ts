import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../../src/pool/backend-users.ts";
import {
  appAttributionReady,
  historyAccountTimeStatements,
  historyAccountTimeSchemaVersion,
  historyTrafficStatements,
  historyTrafficSchemaVersion,
  historyTerminalIntegrityStatements,
  historyAppSchemaVersion,
  historyBaseSchemaVersion,
  historySchemaMigrations,
  historySchemaVersion,
  migrateModelHistory,
} from "../../src/pool/model-history/schema.ts";
import { modelHistorySchemaPlan } from "../../src/pool/model-history/operator.ts";
import { historyOperatorOptions, runHistoryOperator } from "../pool-history-operator.ts";
import { seriesQuery } from "../../src/pool/model-history/series-query.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { homeMetadataFixture } from "./history-fixture.ts";
import { accountAuthority, authority, input, pool, seriesFixture } from "./series-fixture.ts";

test("schema v2 upgrades append traffic and terminal integrity without rewriting retained rows", async () => {
  await seriesFixture(async ({ db, insert }) => {
    await homeMetadataFixture(db);
    // Model a deployed v2 database, retaining its real migrations and append-only triggers.
    await db.query("DROP INDEX basalt_model_requests_account_time");
    await db.query("DROP TABLE basalt_model_traffic");
    await db.query("DROP TABLE basalt_model_terminal_finishes");
    await db.query("DROP TABLE basalt_model_terminal_starts");
    await db.query("DROP INDEX basalt_model_requests_pool_source_request_exact");
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyAccountTimeSchemaVersion,
    ]);
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historySchemaVersion,
    ]);
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyTrafficSchemaVersion,
    ]);
    await insert({ inputTokens: "9007199254740993" });
    const rows = (
      await db.query("SELECT row_to_json(r)::text AS row FROM basalt_model_requests r ORDER BY id")
    ).rows;
    const heaps = (
      await db.query(
        "SELECT relname,relfilenode FROM pg_class WHERE relname LIKE 'basalt_model_requests%' AND relkind='r' ORDER BY relname",
      )
    ).rows;
    assert.equal(await appAttributionReady(db), true);
    const plan = await modelHistorySchemaPlan(db);
    assert.equal(plan.version, historySchemaVersion);
    assert.equal(plan.writes, false);
    assert.equal(plan.additive, true);
    assert.equal(plan.automaticBackfill, false);
    assert.deepEqual(plan.pendingMigrations, [
      historyAccountTimeSchemaVersion,
      historyTrafficSchemaVersion,
      historySchemaVersion,
    ]);
    assert.deepEqual(plan.catalogDiff.createTables, [
      "basalt_model_traffic",
      "basalt_model_terminal_starts",
      "basalt_model_terminal_finishes",
    ]);
    assert.deepEqual(plan.catalogDiff.addColumns, []);
    assert.deepEqual(plan.catalogDiff.addIndexes, [
      "basalt_model_requests_account_time",
      "basalt_model_requests_pool_source_request_exact",
      "basalt_model_terminal_starts_pool_time",
      "basalt_model_terminal_finishes_time",
    ]);
    assert.equal(plan.lockTimeout, "500ms");
    assert.equal(plan.statementTimeout, "5s");
    assert.equal(
      plan.schemaHash,
      createHash("sha256").update(JSON.stringify(historySchemaMigrations)).digest("hex"),
    );
    assert.deepEqual(historyAccountTimeStatements, [
      "CREATE INDEX basalt_model_requests_account_time ON basalt_model_requests (pool, account, timestamp)",
    ]);
    assert.equal(
      (await db.query("SELECT to_regclass('basalt_model_requests_account_time') AS name")).rows[0]!
        .name,
      null,
    );
    const directory = await mkdtemp(join(tmpdir(), "usage-v3-operator-"));
    try {
      const path = join(directory, "plan.json");
      const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
      let writes = 0;
      const connect = async () => ({
        env: {
          POOL_OPERATIONS: {
            fetch: async (request: Request) => {
              if (request.method === "GET")
                return Response.json({ status: "dry-run", ...(await modelHistorySchemaPlan(db)) });
              const approved = (await request.json()) as {
                go: boolean;
                schemaHash: string;
                catalogHash: string;
              };
              assert.equal(approved.go, true);
              const current = await modelHistorySchemaPlan(db);
              assert.equal(approved.schemaHash, current.schemaHash);
              assert.equal(approved.catalogHash, current.catalogHash);
              writes++;
              await migrateModelHistory(db);
              return Response.json({
                status: "complete",
                version: historySchemaVersion,
                schemaHash: current.schemaHash,
                applied: true,
              });
            },
          },
        },
        dispose: async () => {},
      });
      const preview = await runHistoryOperator(options, "a".repeat(32), connect);
      assert.equal(writes, 0);
      assert.deepEqual(preview.pendingDdl, [
        ...historyAccountTimeStatements,
        ...historyTrafficStatements,
        ...historyTerminalIntegrityStatements,
      ]);
      assert.deepEqual(preview.migrationMarkers, [
        {
          text: "INSERT INTO basalt_model_history_migrations (name) VALUES ($1)",
          values: [historyAccountTimeSchemaVersion],
        },
        {
          text: "INSERT INTO basalt_model_history_migrations (name) VALUES ($1)",
          values: [historyTrafficSchemaVersion],
        },
        {
          text: "INSERT INTO basalt_model_history_migrations (name) VALUES ($1)",
          values: [historySchemaVersion],
        },
      ]);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")).report.pendingDdl, [
        ...historyAccountTimeStatements,
        ...historyTrafficStatements,
        ...historyTerminalIntegrityStatements,
      ]);
      await runHistoryOperator({ ...options, apply: true }, "a".repeat(32), connect);
      assert.equal(writes, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await migrateModelHistory(db);
    await migrateModelHistory(db);
    assert.deepEqual(
      (
        await db.query(
          "SELECT row_to_json(r)::text AS row FROM basalt_model_requests r ORDER BY id",
        )
      ).rows,
      rows,
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT relname,relfilenode FROM pg_class WHERE relname LIKE 'basalt_model_requests%' AND relkind='r' ORDER BY relname",
        )
      ).rows,
      heaps,
      "an additive index must not rewrite a partition heap",
    );
    assert.deepEqual(
      (await db.query("SELECT name FROM basalt_model_history_migrations ORDER BY name")).rows.map(
        (row) => row.name,
      ),
      [
        historyBaseSchemaVersion,
        historyAppSchemaVersion,
        historyAccountTimeSchemaVersion,
        historyTrafficSchemaVersion,
        historySchemaVersion,
      ],
    );
    assert.equal(await appAttributionReady(db), true);
    const after = await modelHistorySchemaPlan(db);
    assert.equal(after.applied, true);
    assert.deepEqual(after.pendingMigrations, []);
    assert.deepEqual(after.catalogDiff.addIndexes, []);
    assert.equal(
      (await db.query("SELECT count(*)::text AS n FROM basalt_model_history_cursor")).rows[0]!.n,
      "0",
    );
    await assert.rejects(db.query("UPDATE basalt_model_requests SET input_tokens=0"), {
      code: "55000",
    });
    await assert.rejects(db.query("TRUNCATE basalt_model_requests"), { code: "55000" });
  });
});

test("a retained v3 database gets only the pending traffic and terminal ledgers", async () => {
  await seriesFixture(async ({ db, insert }) => {
    await homeMetadataFixture(db);
    await insert({ inputTokens: "9007199254740993" });
    const before = (
      await db.query("SELECT row_to_json(r)::text AS row FROM basalt_model_requests r")
    ).rows;
    await db.query("DROP TABLE basalt_model_traffic");
    await db.query("DROP TABLE basalt_model_terminal_finishes");
    await db.query("DROP TABLE basalt_model_terminal_starts");
    await db.query("DROP INDEX basalt_model_requests_pool_source_request_exact");
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyTrafficSchemaVersion,
    ]);
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historySchemaVersion,
    ]);
    const plan = await modelHistorySchemaPlan(db);
    assert.deepEqual(plan.pendingMigrations, [historyTrafficSchemaVersion, historySchemaVersion]);
    assert.deepEqual(plan.catalogDiff.createTables, [
      "basalt_model_traffic",
      "basalt_model_terminal_starts",
      "basalt_model_terminal_finishes",
    ]);
    assert.deepEqual(plan.catalogDiff.addIndexes, [
      "basalt_model_requests_pool_source_request_exact",
      "basalt_model_terminal_starts_pool_time",
      "basalt_model_terminal_finishes_time",
    ]);
    assert.deepEqual(plan.catalogDiff.addColumns, []);
    await migrateModelHistory(db);
    assert.deepEqual(
      (await db.query("SELECT row_to_json(r)::text AS row FROM basalt_model_requests r")).rows,
      before,
    );
    assert.equal(
      (await db.query("SELECT count(*)::text AS n FROM basalt_model_traffic")).rows[0]!.n,
      "0",
    );
  });
});

interface Plan {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: Plan[];
}
const scans = (plan: Plan): string[] => [
  ...(plan["Index Name"] ? [plan["Index Name"]] : []),
  ...(plan.Plans ?? []).flatMap(scans),
];

test("EXPLAIN bounded account aggregates use v3 account-time indexes and pool aggregates use existing pool-time indexes", async () => {
  await seriesFixture(async ({ db }) => {
    const native = await accountAuthority();
    await db.query(
      `INSERT INTO basalt_model_requests
      (id,source,source_record,timestamp,timestamp_exact,pool,account,token_quality,failed,cost_basis,attribution)
      SELECT md5(n::text)||md5(n::text),$1,md5(n::text)||md5(n::text),at,
        to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'000Z',
        CASE WHEN n%100=0 THEN $2 ELSE substr(md5((n%100)::text),1,16) END,
        CASE WHEN n%2000=0 THEN $3 ELSE md5((n%2000)::text)||md5((n%2000)::text) END,
        'unclassified',false,'unpriced','unknown'
      FROM (SELECT n,'2025-01-01T00:00:00Z'::timestamptz + (n/100)*interval '1 hour' AS at
        FROM generate_series(1,100000) n) fixture`,
      [native.source, (await digest(pool)).slice(0, 16), native.visible],
    );
    await db.query("ANALYZE basalt_model_requests");
    const families = async (parent: string) =>
      (
        await db.query(
          `SELECT c.relname AS name FROM pg_inherits i
      JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent WHERE p.relname=$1`,
          [parent],
        )
      ).rows.map((row) => String(row.name));
    const accountIndexes = await families("basalt_model_requests_account_time");
    const poolIndexes = await families("basalt_model_requests_pool_time");
    assert.equal(accountIndexes.length, 16);
    assert.equal(poolIndexes.length, 16);
    const explain = async (query: Awaited<ReturnType<typeof seriesQuery>>) => {
      const response = await db.query(`EXPLAIN (FORMAT JSON) ${query.text}`, query.values);
      const [root] = response.rows[0]!["QUERY PLAN"] as { Plan: Plan }[];
      assert.ok(root);
      return root;
    };
    const filtered = await seriesQuery(
      db,
      {
        ...input,
        from: "2025-01-01T00:00:00Z",
        to: "2025-02-12T00:00:00Z",
        accounts: ["saved-visible"],
        by: ["account"],
      },
      native.authority,
    );
    const accountPlan = await explain(filtered);
    const accountScans = scans(accountPlan.Plan);
    assert.ok(accountScans.length > 0);
    assert.ok(
      accountScans.every((name) => accountIndexes.includes(name)),
      JSON.stringify(accountScans),
    );
    const grouped = await seriesQuery(
      db,
      {
        ...input,
        from: "2025-01-02T00:00:00Z",
        to: "2025-01-03T00:00:00Z",
        by: ["provider", "model"],
      },
      authority,
    );
    const poolPlan = await explain(grouped);
    const poolScans = scans(poolPlan.Plan);
    assert.ok(poolScans.length > 0);
    assert.ok(
      poolScans.every((name) => poolIndexes.includes(name)),
      JSON.stringify(poolScans),
    );
    // Refresh representative plans with UPDATE_USAGE_SERIES_PLANS=1 against local Postgres.
    const evidencePath = new URL("./usage-series-plans.json", import.meta.url);
    if (process.env.UPDATE_USAGE_SERIES_PLANS === "1") {
      const version = (await db.query("SHOW server_version")).rows[0]!.server_version;
      await writeFile(
        evidencePath,
        `${JSON.stringify(
          {
            postgresVersion: version,
            fixtureRows: 100_000,
            accountFiltered: accountPlan,
            groupedPool: poolPlan,
          },
          null,
          2,
        )}\n`,
      );
    }
    const retained = JSON.parse(await readFile(evidencePath, "utf8")) as {
      accountFiltered: { Plan: Plan };
      groupedPool: { Plan: Plan };
    };
    for (const [plan, indexes] of [
      [retained.accountFiltered.Plan, accountIndexes],
      [retained.groupedPool.Plan, poolIndexes],
    ] as const) {
      const retainedScans = scans(plan);
      assert.ok(retainedScans.length > 0);
      assert.ok(retainedScans.every((name) => indexes.includes(name)));
    }
  });
});

test("capture coverage carries backfill and sweep state without claiming that an observed maximum completes older history", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const source = await digest("home-local-v1"),
      sourceRecord = await digest(JSON.stringify(["usage", "73"]));
    await insert({ source, sourceRecord });
    await db.query(
      `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,sweep_upper)
      VALUES ($1,73,70,12,false,3,73)`,
      [source],
    );
    const result = await poolUsageSeries(db, input, authority);
    const coverage = result.coverage.sources.find((entry) => entry.source === source)!;
    assert.equal(coverage.backfillComplete, false);
    assert.deepEqual(coverage.sweep, { id: "3", upper: "73" });
    assert.equal(result.coverage.capturedThrough, "2026-01-01T00:45:00.000000000Z");
    assert.ok(result.asOf);
    assert.equal(result.coverage.mapping.historicalGenerations, "unknown");
  });
});
