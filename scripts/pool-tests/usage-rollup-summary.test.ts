import assert from "node:assert/strict";
import { test } from "node:test";
import type { OverviewApiPrice } from "../../apps/pool/overview-contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { summarySelection } from "../../src/pool/model-history/summary-query.ts";
import { summaryModeTargets } from "../../src/pool/model-history/summary-rollup-query.ts";
import {
  usageRollupTargets,
  type UsageRollupTarget,
} from "../../src/pool/model-history/usage-rollup-targets.ts";
import { historyCaptureHoursVersion } from "../../src/pool/model-history/capture-hours-schema.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

/** A long-context tier on one model, so a request's context band chooses its rate. */
const prices: readonly OverviewApiPrice[] = [
  ...summaryPrices,
  { ...summaryPrices[1]!, minInput: "200001", input: "20", output: "60", cacheRead: "4" },
];

/** Requests of every shape the summary prices, counts or redacts differently. */
async function history(f: Parameters<Parameters<typeof seriesFixture>[0]>[0]) {
  const fixture = await summaryFixture(f);
  const gateway = await digest("pool-gateway-v1");
  const imported = await digest("fixture-import");
  let id = 0;
  for (let day = 0; day < 9; day++)
    for (let hour = 0; hour < 24; hour += 5) {
      const at = (minute: number) =>
        new Date(Date.UTC(2026, 0, 1 + day, hour, minute, 7)).toISOString();
      await fixture.native(++id, at(1), { model: "fixture-model-0" });
      await fixture.native(++id, at(2), {
        model: "fixture-model-1",
        apiType: "responses",
        inputTokens: String(150_000 + day * 20_000),
        cacheReadTokens: "1000",
        cacheWriteTokens: "500",
        outputTokens: "333",
        totalTokens: String(150_333 + day * 20_000),
      });
      await fixture.native(++id, at(3), {
        account: fixture.hidden,
        apiType: "messages",
        tokenQuality: "legacy",
      });
      await fixture.native(++id, at(4), { failed: true, statusCode: hour % 2 ? 429 : 500 });
      await f.insert(
        {
          source: gateway,
          timestamp: timestamp(at(5)),
          provider: "fixture-lab",
          model: "fixture-model-0",
          failed: true,
          statusCode: 503,
          attribution: "key-at-capture",
        },
        {
          source: imported,
          attribution: "import-owner",
          account: `i:${"e".repeat(62)}`,
          timestamp: timestamp(at(6)),
          provider: "fixture-lab",
          model: "fixture-model-1",
          inputTokens: "900",
          outputTokens: "90",
          cacheReadTokens: "0",
          cacheWriteTokens: "0",
          totalTokens: "990",
          tokenQuality: "complete",
          costBasis: "historical-api-price",
          cost: "0.0123",
          currency: "USD",
        },
        { timestamp: timestamp(at(7)), provider: "fixture-lab", model: null },
      );
    }
  // Rows on both sides of the off-hour boundaries: the previous range's start and the read's end.
  for (const at of [
    "2025-12-27T08:10:00Z",
    "2025-12-27T08:40:00Z",
    "2026-01-09T13:20:00Z",
    "2026-01-09T13:50:00Z",
  ])
    await fixture.native(++id, at, { model: "fixture-model-0" });
  // History before the heatmap's start: the summary's training range reads it, the heatmap and
  // native hours must leave it out.
  await fixture.native(++id, "2025-11-01T09:30:00Z", { model: "fixture-model-0" });
  await fixture.cursor(id);
  await fixture.analyze();
  return fixture;
}

async function summary(
  db: HistoryDatabase,
  authority: unknown,
  by: "provider" | "model",
  rollupGroups?: number,
) {
  const to = "2026-01-09T13:37:12.000000123Z";
  return poolUsageSummary(
    db,
    { pool, from: "2026-01-02T23:00:00Z", to, by, authority },
    async () => ({ prices, issues: [] }),
    Date.parse(to),
    undefined,
    undefined,
    rollupGroups,
  );
}

/** Recomputes the fixture's days into one rollup and marks the pool ready on it. */
async function backfill(db: HistoryDatabase, target: UsageRollupTarget) {
  const poolId = (await digest(pool)).slice(0, 16);
  const rollup = usageRollupTargets[target];
  for (let day = 0; day < 10; day++)
    await db.query(`SELECT ${rollup.recompute}($1,$2::timestamptz,$3::timestamptz)`, [
      poolId,
      new Date(Date.UTC(2025, 11, 31 + day)).toISOString(),
      new Date(Date.UTC(2025, 11, 32 + day)).toISOString(),
    ]);
  await db.query(`INSERT INTO ${rollup.ready} (pool,through) VALUES ($1,$2)`, [
    poolId,
    "2026-01-10T00:00:00Z",
  ]);
  if (target === "v16") await withoutCaptureHours(db);
}

/** Both summaries, counting the statements the second one ran. */
async function summaries(db: HistoryDatabase, authority: unknown, rollupGroups?: number) {
  const statements: string[] = [];
  const counted: HistoryDatabase = {
    query: (text, values) => {
      statements.push(text);
      return db.query(text, values);
    },
  };
  return {
    provider: await summary(counted, authority, "provider", rollupGroups),
    model: await summary(counted, authority, "model", rollupGroups),
    statements,
  };
}

// Only the reads' own transaction times may differ; every usage figure must not.
const data = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (key, field) =>
      key === "capturedAt" || key === "asOf" ? "read time" : field,
    ),
  );

for (const target of ["v15", "v16"] as const)
  test(`a summary read from the ${target} rollup is identical to the same summary read from raw rows`, async () => {
    await seriesFixture(async (f) => {
      const fixture = await history(f);
      const raw = await summaries(f.db, fixture.authority);
      await backfill(f.db, target);
      const rolled = await summaries(f.db, fixture.authority);
      // The statement after the targets names the rollup only on the rollup path.
      assert.ok(
        rolled.statements[3]!.includes(usageRollupTargets[target].hourly),
        "the second read uses the rollup",
      );
      assert.ok(!raw.statements[3]!.includes("basalt_model_usage"), "the first read is raw");
      assert.deepEqual(data(rolled.provider), data(raw.provider));
      assert.deepEqual(data(rolled.model), data(raw.model));
      assert.ok(raw.provider.daily.length > 0 && raw.model.models?.status === "available");
    });
  });

for (const target of ["v15", "v16"] as const)
  test(`after its targets, a summary on the ${target} rollup reads its window's groups once`, async () => {
    await seriesFixture(async (f) => {
      const fixture = await history(f);
      await backfill(f.db, target);
      const hourly = usageRollupTargets[target].hourly;
      const statements: { step?: string; text: string; values?: unknown[] }[] = [];
      let step: string | undefined;
      const to = "2026-01-09T13:37:12.000000123Z";
      await poolUsageSummary(
        {
          query: (text, values) => {
            statements.push({ step, text, values });
            return f.db.query(text, values);
          },
        },
        { pool, from: "2026-01-02T23:00:00Z", to, by: "model", authority: fixture.authority },
        async () => ({ prices, issues: [] }),
        Date.parse(to),
        (next) => (step = next),
      );
      // The targets statement keeps its own bounded count; the coverage, daily and hourly figures
      // after it are what this read shares.
      const figures = statements.filter(
        (statement) =>
          ["figures", "coverage", "daily", "hourly"].includes(statement.step ?? "") &&
          statement.text.includes(hourly),
      );
      assert.ok(figures.length > 0, "the summary reads the rollup");
      let scanned = 0;
      for (const { text, values } of figures) {
        const plan = (await f.db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values)).rows[0]!;
        const visit = (node: Record<string, unknown>) => {
          if (node["Relation Name"] === hourly)
            scanned += Number(node["Actual Rows"]) * Number(node["Actual Loops"]);
          for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
            visit(child);
        };
        visit((plan["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0]!.Plan);
      }
      const poolId = (await digest(pool)).slice(0, 16);
      const groups = Number(
        (await f.db.query(`SELECT count(*)::int AS n FROM ${hourly} WHERE pool=$1`, [poolId]))
          .rows[0]!.n,
      );
      assert.ok(groups > 0);
      assert.ok(
        scanned <= groups,
        `the figures read ${scanned} rollup rows in ${figures.length} statements, for ${groups} groups`,
      );
    });
  });

test("a pool ready on v15 keeps reading v15 until its v16 backfill is complete, then reads v16", async () => {
  await seriesFixture(async (f) => {
    const fixture = await history(f);
    const raw = await summaries(f.db, fixture.authority);
    await backfill(f.db, "v15");
    // v16's hours are recomputed, but the pool is not ready on v16 until its backfill finishes.
    const poolId = (await digest(pool)).slice(0, 16);
    await f.db.query(
      "SELECT basalt_model_usage_people_recompute($1,'2026-01-03T00:00:00Z','2026-01-04T00:00:00Z')",
      [poolId],
    );
    const before = await summaries(f.db, fixture.authority);
    assert.ok(before.statements[3]!.includes("basalt_model_usage_hourly"), "still v15");
    assert.ok(!before.statements[3]!.includes("basalt_model_usage_people_hourly"));
    await f.db.query("DELETE FROM basalt_model_usage_people_hours");
    await backfill(f.db, "v16");
    const after = await summaries(f.db, fixture.authority);
    assert.ok(after.statements[3]!.includes("basalt_model_usage_people_hourly"), "now v16");
    for (const read of [before, after]) {
      assert.deepEqual(data(read.provider), data(raw.provider));
      assert.deepEqual(data(read.model), data(raw.model));
    }
  });
});

test("before history migration v15 is applied the summary still answers from raw rows", async () => {
  await seriesFixture(async (f) => {
    const fixture = await history(f);
    // A database the release has not migrated to v15 yet: no rollup tables, no trigger.
    await f.db.query(
      "DROP TABLE basalt_model_usage_ready, basalt_model_usage_hours, basalt_model_usage_hourly CASCADE",
    );
    await f.db.query("DROP TRIGGER basalt_model_usage_rollup ON basalt_model_requests");
    const result = await summary(f.db, fixture.authority, "provider");
    assert.ok(result.daily.length > 0);
  });
});

test("an unseparated price tier on a ready pool keeps the rollup read and marks that pair unpriced", async () => {
  await seriesFixture(async (f) => {
    const fixture = await history(f);
    const poolId = (await digest(pool)).slice(0, 16);
    await f.db.query("SELECT basalt_model_usage_recompute($1,$2::timestamptz,$3::timestamptz)", [
      poolId,
      "2025-12-27T00:00:00Z",
      "2025-12-28T00:00:00Z",
    ]);
    for (let day = 0; day < 10; day++)
      await f.db.query("SELECT basalt_model_usage_recompute($1,$2::timestamptz,$3::timestamptz)", [
        poolId,
        new Date(Date.UTC(2025, 11, 31 + day)).toISOString(),
        new Date(Date.UTC(2025, 11, 32 + day)).toISOString(),
      ]);
    await f.db.query("INSERT INTO basalt_model_usage_ready (pool,through) VALUES ($1,$2)", [
      poolId,
      "2026-01-10T00:00:00Z",
    ]);
    const statements: string[] = [];
    const to = "2026-01-09T13:37:12.000000123Z";
    const result = await poolUsageSummary(
      {
        query: (text, values) => {
          statements.push(text);
          return f.db.query(text, values);
        },
      },
      { pool, from: "2026-01-02T23:00:00Z", to, by: "provider", authority: fixture.authority },
      async () => ({
        prices: [...prices, { ...summaryPrices[0]!, minInput: "150000", input: "99" }],
        issues: [],
      }),
      Date.parse(to),
    );
    assert.ok(statements[3]!.includes("basalt_model_usage_hourly"), "the read stays on the rollup");
    assert.ok(statements.length <= 15);
    assert.ok(result.daily.length > 0);
    // The pair with the unseparated tier is unpriced, and the reason says so.
    assert.ok(
      JSON.stringify(result).includes("has a price tier that summarized usage cannot apply yet"),
    );
    // Over the group bound, a ready pool's first statement refuses before any rolled scan.
    const selection = await summarySelection(
      pool,
      timestamp("2025-10-01T00:00:00Z"),
      timestamp(to),
      fixture.authority,
    );
    const bounded = summaryModeTargets(
      selection,
      100_000,
      [selection.values[1] as string, selection.values[2] as string],
      true,
      1,
    );
    const first = (await f.db.query(bounded.text, bounded.values)).rows;
    assert.ok(first.some((row) => row.kind === "over" && Number(row.window_rows) === 2));
    assert.equal(first.filter((row) => row.kind === "target").length, 0);
  });
});

test("a pool whose v16 window is past the group bound keeps reading v15 instead of refusing", async () => {
  await seriesFixture(async (f) => {
    const fixture = await history(f);
    // Twenty people behind one provider, model and hour: one v15 group, twenty v16 groups.
    await f.insert(
      ...(await Promise.all(
        Array.from({ length: 20 }, async (_, i) => ({
          timestamp: timestamp("2026-01-05T10:15:00Z"),
          provider: "fixture-lab",
          model: "fixture-model-wide",
          person: await digest(`fixture-person-${i}`),
          inputTokens: "100",
          outputTokens: "10",
          totalTokens: "110",
          tokenQuality: "complete" as const,
        })),
      )),
    );
    const raw = await summaries(f.db, fixture.authority);
    await backfill(f.db, "v15");
    await backfill(f.db, "v16");
    const groups = async (table: string) =>
      Number((await f.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);
    const v15 = await groups("basalt_model_usage_hourly");
    const v16 = await groups("basalt_model_usage_people_hourly");
    assert.ok(v16 > v15, `people and apps widen the groups: ${v16} against ${v15}`);
    // A bound v15's window fits and v16's does not.
    const read = await summaries(f.db, fixture.authority, v15);
    assert.ok(!read.statements[3]!.includes("basalt_model_usage_people_hourly"), "still v15");
    assert.ok(read.statements[3]!.includes("basalt_model_usage_hourly"));
    assert.deepEqual(data(read.provider), data(raw.provider));
    assert.deepEqual(data(read.model), data(raw.model));
  });
});

/**
 * The fixture's January 2026 window reaches past the 400 days capture-hour counts cover, where no
 * hour reads complete by design. This test proves the rollup equals raw rows, so it reads capture as
 * before v17, on both sides: v17's table and record dropped.
 */
async function withoutCaptureHours(db: HistoryDatabase) {
  await db.query("DROP TABLE basalt_model_capture_hours");
  await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
    historyCaptureHoursVersion,
  ]);
}
