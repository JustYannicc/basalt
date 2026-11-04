import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../../src/pool/backend-users.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import type {
  PoolUsageSeriesInput,
  SeriesAuthority,
} from "../../src/pool/model-history/series-contract.ts";
import { accountAuthority, authority, input, pool, seriesFixture } from "./series-fixture.ts";

async function seed(
  db: HistoryDatabase,
  options: { count: number; source: string; account?: string; groups?: boolean; wide?: boolean },
) {
  await db.query(
    `INSERT INTO basalt_model_requests
    (id,source,source_record,timestamp,timestamp_exact,pool,account,model,token_quality,failed,cost_basis,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,total_tokens,attribution)
    SELECT md5(n::text)||md5(n::text),$1,md5(n::text)||md5(n::text), at,
      to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'000Z',$2,$3,
      ${options.groups ? "'model-'||lpad(n::text,5,'0')" : options.wide ? "repeat('m',256)" : "NULL"},
      'complete',false,'unpriced',9007199254740993,9007199254740993,0,0,0,18014398509481986,'unknown'
    FROM (SELECT n,'2025-01-01T00:00:00Z'::timestamptz + ${options.groups ? "interval '0 hours'" : "n*interval '1 hour'"} AS at
      FROM generate_series(1,$4::int) n) fixture`,
    [options.source, (await digest(pool)).slice(0, 16), options.account ?? null, options.count],
  );
}
const range: PoolUsageSeriesInput = {
  ...input,
  from: "2025-01-01T00:00:00Z",
  to: "2026-02-05T00:00:00Z",
};
async function pages(db: HistoryDatabase, query: PoolUsageSeriesInput, access: SeriesAuthority) {
  const seen = new Set<string>();
  const lengths: number[] = [];
  let after: string | undefined;
  do {
    const page = await poolUsageSeries(db, { ...query, ...(after ? { after } : {}) }, access);
    lengths.push(page.groups.reduce((sum, group) => sum + group.buckets.length, 0));
    assert.ok(lengths.at(-1)! <= 5000);
    assert.ok(page.groups.length <= 500);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1_048_576);
    for (const group of page.groups)
      for (const bucket of group.buckets) {
        const key = JSON.stringify([group.key, bucket.at]);
        assert.equal(
          seen.has(key),
          false,
          "the full group key and bucket must not repeat across pages",
        );
        seen.add(key);
      }
    after = page.next ?? undefined;
    assert.ok(lengths.length < 20, "a keyset must make bounded forward progress");
  } while (after);
  return { seen, lengths };
}

test("5,000 bucket rows bind before bytes for counts-only groups; a page can continue within one group", async () => {
  await seriesFixture(async ({ db }) => {
    const native = await accountAuthority();
    await seed(db, { count: 6000, source: native.source, account: native.hidden });
    const result = await pages(db, range, native.authority);
    assert.deepEqual(result.lengths, [5000, 1000]);
    assert.equal(result.seen.size, 6000);
  });
});

test("the 1 MiB byte cap binds before the row cap without losing a currency or a bucket", async () => {
  await seriesFixture(async ({ db, insert }) => {
    await seed(db, { count: 3000, source: await digest("wide-import"), wide: true });
    await insert(
      {
        timestamp: timestamp("2025-01-01T01:00:00Z"),
        model: "m".repeat(256),
        cost: "1.000000000000",
        currency: "credits",
        costBasis: "home-charge",
      },
      {
        timestamp: timestamp("2025-01-01T01:00:00Z"),
        model: "m".repeat(256),
        cost: "2.000000000000",
        currency: "USD",
        costBasis: "historical-api-price",
      },
    );
    const query = { ...range, by: ["model"] };
    const result = await pages(db, query as PoolUsageSeriesInput, authority);
    assert.ok(result.lengths.length > 1);
    assert.ok(result.lengths[0]! < 5000);
    assert.equal(result.seen.size, 3002);
    const first = await poolUsageSeries(db, query, authority);
    const changed = { ...query, to: "2026-02-04T00:00:00Z", after: first.next };
    await assert.rejects(poolUsageSeries(db, changed, authority), /Invalid model usage metadata/);
    const tampered = JSON.parse(first.next!);
    tampered.key = JSON.stringify({ currency: "USD" });
    await assert.rejects(
      poolUsageSeries(db, { ...query, after: JSON.stringify(tampered) }, authority),
      /Invalid model usage metadata/,
      "a cursor must retain the entire key, including currency and every requested dimension",
    );
  });
});

test("500 distinct groups page independently of bucket count; late imports change asOf and require a range reread", async () => {
  await seriesFixture(async ({ db, insert }) => {
    await seed(db, { count: 650, source: await digest("grouped-import"), groups: true });
    const query: PoolUsageSeriesInput = {
      ...range,
      by: ["model", "source", "attribution", "app", "provider", "person", "account"],
    };
    const before = await poolUsageSeries(db, query, authority);
    assert.equal(before.groups.length, 500);
    assert.ok(before.next);
    const last = before.groups.at(-1)!;
    const cursor = JSON.parse(before.next!);
    assert.deepEqual(JSON.parse(cursor.key), last.key);
    assert.equal(timestamp(cursor.at), last.buckets.at(-1)!.at);
    const later = await insert({
      timestamp: timestamp("2025-01-01T00:00:00Z"),
      model: "aaaa-late-import",
      source: await digest("grouped-import"),
    });
    const next = await poolUsageSeries(db, { ...query, after: before.next }, authority);
    assert.ok(next.asOf! > before.asOf!);
    assert.equal(next.groups.length, 150);
    assert.equal(
      next.groups.some((group) => group.key.model === "aaaa-late-import"),
      false,
    );
    const reread = await pages(db, query, authority);
    assert.equal(reread.seen.size, 651);
    assert.equal(
      (
        await db.query("SELECT timestamp_exact FROM basalt_model_requests WHERE id=$1", [
          later[0]!.id,
        ])
      ).rows[0]!.timestamp_exact,
      timestamp("2025-01-01T00:00:00Z"),
      "late ingestion never rewrites the request timestamp",
    );
    await assert.rejects(db.query("UPDATE basalt_model_requests SET failed=true"), {
      code: "55000",
    });
    await assert.rejects(db.query("DELETE FROM basalt_model_requests"), { code: "55000" });
  });
});
