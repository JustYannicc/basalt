import assert from "node:assert/strict";
import { test } from "node:test";
import type { OverviewApiPrice } from "../../apps/pool/overview-contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolPersonalUsageSeries, poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import {
  seriesDimensions,
  type PoolUsageSeriesInput,
  type SeriesAuthority,
} from "../../src/pool/model-history/series-contract.ts";
import {
  planUsageRollup,
  runUsageRollup,
} from "../../src/pool/model-history/usage-rollup-backfill.ts";
import { accountAuthority, pool, seriesFixture } from "./series-fixture.ts";

const persons = Array.from({ length: 6 }, (_, i) => String(i + 1).repeat(64));
const price = (model: string, overrides: Partial<OverviewApiPrice> = {}): OverviewApiPrice => ({
  provider: "fixture-lab",
  model,
  currency: "USD",
  input: "1.25",
  output: "10",
  cacheRead: "0.125",
  cacheWrite: "0",
  request: "0.0001",
  tier: "*",
  minInput: "0",
  asOf: "2026-11-04T00:00:00.000Z",
  source: "models.dev",
  version: "fixture-v1",
  ...overrides,
});
/** Long-context and service tiers on the bands the rollup separates; one pair has no price. */
const prices: readonly OverviewApiPrice[] = [
  price("fixture-model-0"),
  price("fixture-model-0", {
    minInput: "200001",
    input: "2.5",
    output: "15",
    version: "fixture-v2",
  }),
  price("fixture-model-1", { cacheWrite: "3.75", request: "0" }),
  price("fixture-model-1", { tier: "priority", input: "2.5", basis: "baseline" }),
];
const priceTable = async (targets: readonly { provider: string; model: string }[]) => ({
  prices: prices.filter((row) =>
    targets.some((target) => target.provider === row.provider && target.model === row.model),
  ),
  issues: [],
});

/**
 * History in every shape the series groups, maps, redacts and prices differently: native, gateway
 * and imported sources, owner imports, people, apps, accounts mapped, hidden, unmapped and absent,
 * every token quality and API type, failures and limits, every cost basis, over a DST change, at
 * sub-microsecond times. Half of it predates the v16 trigger, as production's history does, and
 * more arrives after the pool is ready, merged by the trigger into groups that already exist.
 */
async function history(
  f: Parameters<Parameters<typeof seriesFixture>[0]>[0],
  /** A request table at the base schema: no app attribution column, as before migration v2. */
  base = false,
) {
  if (base) {
    await f.db.query(
      "DELETE FROM basalt_model_history_migrations WHERE name='model_request_history_v2_app_attribution'",
    );
    await f.db.query(
      "ALTER TABLE basalt_model_requests DROP COLUMN app_id, DROP COLUMN requirement",
    );
  }
  const { visible, hidden, authority } = await accountAuthority();
  const home = await digest("home-local-v1");
  const gateway = await digest("pool-gateway-v1");
  const imported = await digest("fixture-import");
  const foreign = await digest("fixture-other-import");
  const poolId = (await digest(pool)).slice(0, 16);
  const insert = (from: number, to: number, target: string, salt = "") =>
    f.db.query(
      `INSERT INTO basalt_model_requests (id,source,source_record,timestamp,timestamp_exact,pool,person,
        account,${base ? "" : "app_id,"}attribution,provider,model,service_tier,api_type,input_tokens,output_tokens,
        cache_read_tokens,cache_write_tokens,reasoning_tokens,total_tokens,token_quality,failed,
        status_code,cost,currency,cost_basis,price_version,price_snapshot)
      SELECT encode(sha256(convert_to('people-'||$10||$11||'-'||n,'UTF8')),'hex'),src,
        encode(sha256(convert_to('record-'||$10||$11||'-'||n,'UTF8')),'hex'),at,
        to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||lpad((n%1000)::text,3,'0')||'Z',
        $10,CASE WHEN n%7=0 THEN NULL ELSE ($9::text[])[1+n%6] END,
        CASE WHEN src=$3 THEN 'i:'||repeat(CASE WHEN n%2=0 THEN 'e' ELSE 'f' END,62)
          WHEN src=$4 THEN repeat('d',64)
          WHEN n%6=0 THEN $5 WHEN n%6=1 THEN $6 WHEN n%6=2 THEN repeat('c',64)
          WHEN n%6=3 THEN NULL ELSE $5 END,
        ${base ? "" : "(ARRAY[NULL,'fixture-app-a','fixture-app-b'])[1+n%3],"}
        CASE WHEN src=$3 THEN 'import-owner'
          ELSE (ARRAY['charge-snapshot','key-at-capture','unknown','key-at-capture'])[1+n%4] END,
        (ARRAY['fixture-lab','fixture-lab','other-lab',NULL,'fixture-lab'])[1+n%5],
        (ARRAY['fixture-model-0','fixture-model-1','other-model',NULL,NULL])[1+n%5],
        CASE WHEN n%9=0 THEN 'priority' END,
        (ARRAY['responses','messages',NULL,'responses-compact'])[1+n%4],
        CASE WHEN n%17=0 THEN NULL ELSE 1000+(n*7919)%300000 END,
        CASE WHEN n%19=0 THEN NULL ELSE 10+n%500 END,
        CASE WHEN n%23=0 THEN NULL WHEN n%11=0 THEN 400000 ELSE (n%5)*100 END,
        CASE WHEN n%29=0 THEN NULL ELSE (n%3)*50 END,
        CASE WHEN n%2=0 THEN NULL ELSE n%40 END,
        CASE WHEN n%31=0 THEN NULL ELSE 1010+(n*7919)%300000+n%500 END,
        (ARRAY['complete','complete','legacy','unclassified','inconsistent','complete','legacy'])[1+n%7],
        n%13=0, CASE WHEN n%13=0 THEN (ARRAY[429,500,503])[1+n%3] WHEN n%37=0 THEN 429
          WHEN n%5=0 THEN NULL ELSE 200 END,
        CASE WHEN n%6 IN (0,1,2) THEN round((n%1000)/7.0,9) END,
        CASE WHEN n%6 IN (0,1) THEN 'USD' WHEN n%6=2 THEN 'EUR' END,
        CASE WHEN n%6=0 THEN 'home-charge' WHEN n%6 IN (1,2) THEN 'historical-api-price'
          ELSE 'unpriced' END,
        CASE WHEN n%6 IN (0,1,2) AND n%4<>0 THEN repeat('a',64) END,
        CASE WHEN n%6 IN (0,1,2) AND n%4 IN (1,2) THEN '{}'::jsonb END
      FROM generate_series($1::int,$2::int) n
      CROSS JOIN LATERAL (SELECT (ARRAY[$7,$7,$8,$3,$4])[1+n%5]::char(64) AS src,
        '2026-03-27T00:00:00Z'::timestamptz + interval '1 second'*(n*103)
          + interval '1 microsecond'*((n*7919)%1000000) AS at) x`,
      [from, to, imported, foreign, visible, hidden, home, gateway, persons, target, salt],
    );
  // History before the v16 trigger existed, then history it saw, and another pool's beside it.
  await f.db.query(
    "ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_people_rollup",
  );
  await insert(1, 2_000, poolId);
  await f.db.query(
    "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_people_rollup",
  );
  await insert(2_001, 4_000, poolId);
  await insert(1, 300, "0123456789abcdef");
  // The backfill, as the tick runs it, recomputes the hours that predate the trigger.
  const { plan } = await planUsageRollup(f.db);
  assert.equal(plan.rollup, "v16");
  for (let run = 0; ; run++) {
    assert.ok(run < 20, "the backfill finishes");
    if ((await runUsageRollup(f.db, plan, 60_000)).status === "complete") break;
  }
  // After the pool is ready, the trigger alone merges new rows into hours the backfill already
  // recomputed, which is what a ready pool reads from then on.
  await insert(1, 1_500, poolId, ":after-ready");
  await f.db.query("ANALYZE basalt_model_requests");
  return { authority, poolId, home, gateway };
}

/** Reads `work` from raw rows, then from the v16 rollup, and proves which path each one took. */
async function both<T>(
  f: { db: HistoryDatabase },
  poolId: string,
  work: (db: HistoryDatabase) => Promise<T>,
) {
  const results: T[] = [];
  for (const rolled of [false, true]) {
    await f.db.query("DELETE FROM basalt_model_usage_people_ready");
    if (rolled)
      await f.db.query(
        "INSERT INTO basalt_model_usage_people_ready (pool,through) VALUES ($1,'2026-04-02T00:00:00Z')",
        [poolId],
      );
    const statements: string[] = [];
    results.push(
      await work({
        query: (text, values) => {
          statements.push(text);
          return f.db.query(text, values);
        },
      }),
    );
    assert.equal(
      statements.some((text) => text.includes("basalt_model_usage_people_hourly")),
      rolled,
      rolled ? "the ready pool reads the rollup" : "a pool not ready reads raw rows only",
    );
  }
  return results as [T, T];
}

const ranges = [
  // Bounds off the hour, below the microsecond, around the DST change of 2026-03-29.
  { from: "2026-03-27T05:17:03.5Z", to: "2026-03-31T09:42:11.000000123Z" },
  { from: "2026-03-27T00:00:00Z", to: "2026-04-01T00:00:00Z" },
  // Inside one hour: every row is cut, none is read from the rollup.
  { from: "2026-03-29T00:10:00Z", to: "2026-03-29T00:50:00.000000001Z" },
];
const buckets = [
  { bucket: "hour" as const },
  { bucket: "hour" as const, timezone: "UTC" as const },
  { bucket: "day" as const },
  { bucket: "day" as const, timezone: "Europe/Zurich" as const },
];

/** Every page of one read, following its cursor. */
async function pages<T extends { next: string | null }>(read: (after?: string) => Promise<T>) {
  const all = [await read()];
  while (all.at(-1)!.next !== null) {
    assert.ok(all.length < 50, "the read ends");
    all.push(await read(all.at(-1)!.next!));
  }
  return all;
}

test("the manager series read from the v16 rollup equals the raw series, page by page", async () => {
  await seriesFixture(async (f) => {
    const { authority, poolId, home } = await history(f);
    const unproven: SeriesAuthority = { ...authority, mappingProven: false };
    const groupings = [
      [],
      ...seriesDimensions.map((dimension) => [dimension]),
      [...seriesDimensions],
      ["person", "model"],
      ["account", "app", "source"],
    ] as const;
    const cases: { input: Omit<PoolUsageSeriesInput, "pool">; authority: SeriesAuthority }[] = [];
    for (const range of ranges)
      for (const bucket of buckets)
        for (const by of groupings)
          cases.push({ input: { ...range, ...bucket, by: [...by] }, authority });
    for (const by of [["account"], [...seriesDimensions]] as const)
      cases.push(
        { input: { ...ranges[0]!, bucket: "hour", by: [...by] }, authority: unproven },
        {
          input: { ...ranges[0]!, bucket: "day", by: [...by], accounts: ["saved-visible"] },
          authority,
        },
        { input: { ...ranges[0]!, bucket: "hour", by: [...by], sources: [home] }, authority },
        {
          input: { ...ranges[0]!, bucket: "day", by: [...by], window: ranges[2]! },
          authority,
        },
      );
    cases.push({
      input: {
        ...ranges[1]!,
        bucket: "day",
        timezone: "Europe/Zurich",
        by: ["provider"],
        forecast: true,
      },
      authority,
    });
    let paged = 0,
      estimated = 0;
    for (const { input, authority: caller } of cases)
      for (const priced of [true, false]) {
        const [raw, rolled] = await both(f, poolId, (db) =>
          pages((after) =>
            poolUsageSeries(
              db,
              { pool, ...input, ...(after ? { after } : {}) },
              caller,
              "owned",
              priced ? priceTable : undefined,
            ),
          ),
        );
        assert.deepEqual(rolled, raw, JSON.stringify({ input, priced }));
        if (raw.length > 1) paged++;
        if (/"pricedRequests":[1-9]/.test(JSON.stringify(raw))) estimated++;
      }
    assert.ok(paged > 0, "some reads span several pages");
    assert.ok(estimated > 0, "some reads price requests at public rates");
  });
});

test("the personal series read from the v16 rollup equals the raw personal series", async () => {
  await seriesFixture(async (f) => {
    const { poolId, home, gateway } = await history(f);
    for (const person of [persons[0]!, persons[3]!])
      for (const range of ranges)
        for (const bucket of buckets)
          for (const by of [
            [],
            ["person"],
            ["model", "provider"],
            ["person", "model", "provider"],
          ] as const) {
            const input = { pool, ...range, ...bucket, by: [...by], sources: [home, gateway] };
            const [raw, rolled] = await both(f, poolId, (db) =>
              pages((after) =>
                poolPersonalUsageSeries(db, { ...input, ...(after ? { after } : {}) }, person),
              ),
            );
            assert.deepEqual(rolled, raw, JSON.stringify({ person, input }));
            assert.ok(
              raw[0]!.groups.length > 0 || range === ranges[2],
              "the person has usage in the range",
            );
          }
  });
});

test("on the rollup, a price tier its bands cannot separate makes that pair's estimate unavailable", async () => {
  await seriesFixture(async (f) => {
    const { authority, poolId } = await history(f);
    const unseparated = async (targets: readonly { provider: string; model: string }[]) => ({
      prices: [
        ...(await priceTable(targets)).prices,
        price("fixture-model-0", { minInput: "150000", input: "9" }),
      ],
      issues: [],
    });
    const [raw, rolled] = await both(f, poolId, (db) =>
      poolUsageSeries(
        db,
        { pool, ...ranges[0]!, bucket: "day", by: ["model", "provider"] },
        authority,
        "owned",
        unseparated,
      ),
    );
    assert.doesNotMatch(JSON.stringify(raw), /summarized usage cannot apply yet/);
    assert.match(JSON.stringify(rolled), /summarized usage cannot apply yet/);
    // Every figure but the estimates is the raw read's.
    const counts = (value: typeof raw) =>
      JSON.parse(
        JSON.stringify(value, (key, field) => (key === "apiEstimate" ? undefined : field)),
      );
    assert.deepEqual(counts(rolled), counts(raw));
  });
});

test("on a request table at the base schema, with no app column, the series and the summary from v16 equal raw rows", async () => {
  await seriesFixture(async (f) => {
    const { authority, poolId } = await history(f, true);
    // Every row of such a table has no app: the rollup keys it as a row whose app is unknown.
    assert.deepEqual(
      (await f.db.query("SELECT DISTINCT app_id FROM basalt_model_usage_people_hourly")).rows,
      [{ app_id: null }],
    );
    for (const range of ranges)
      for (const by of [["app"], ["app", "person", "model"], [...seriesDimensions]] as const) {
        const [raw, rolled] = await both(f, poolId, (db) =>
          pages((after) =>
            poolUsageSeries(
              db,
              { pool, ...range, bucket: "hour", by: [...by], ...(after ? { after } : {}) },
              authority,
              "owned",
              priceTable,
            ),
          ),
        );
        assert.deepEqual(rolled, raw, JSON.stringify({ range, by }));
      }
    // The summary names the rollup it reads in its coverage statement, its fourth.
    const to = ranges[1]!.to;
    const summary = async (ready: boolean) => {
      await f.db.query("DELETE FROM basalt_model_usage_people_ready");
      if (ready)
        await f.db.query(
          "INSERT INTO basalt_model_usage_people_ready (pool,through) VALUES ($1,'2026-04-02T00:00:00Z')",
          [poolId],
        );
      const statements: string[] = [];
      const read = await poolUsageSummary(
        {
          query: (text, values) => {
            statements.push(text);
            return f.db.query(text, values);
          },
        },
        { pool, from: ranges[1]!.from, to, by: "model", authority },
        priceTable,
        Date.parse(to),
      );
      assert.equal(statements[3]!.includes("basalt_model_usage_people_hourly"), ready);
      return JSON.parse(
        JSON.stringify(read, (key, value) =>
          key === "capturedAt" || key === "asOf" ? "read time" : value,
        ),
      );
    };
    assert.deepEqual(await summary(true), await summary(false));
  });
});
