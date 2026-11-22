import assert from "node:assert/strict";
import { test } from "node:test";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { seriesFixture } from "./series-fixture.ts";

/** The raw answer the rollup must reproduce exactly: one group per pool, UTC hour, source and model. */
const raw = `SELECT pool,date_trunc('hour',timestamp) AS hour,source,provider,model,
    count(*)::text AS requests,nullif(count(*) FILTER (WHERE failed),0)::text AS failed,
    sum(input_tokens)::text AS input,sum(output_tokens)::text AS output,
    sum(total_tokens)::text AS total,max(timestamp_exact) AS last_at
  FROM basalt_model_requests GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;
const rolled = `SELECT pool,hour,source,provider,model,
    sum(requests)::text AS requests,(sum(requests) FILTER (WHERE failed))::text AS failed,
    sum(input_tokens_sum)::text AS input,sum(output_tokens_sum)::text AS output,
    sum(total_tokens_sum)::text AS total,max(last_at) AS last_at
  FROM basalt_model_usage_hourly GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;

test("every insert into the request history keeps the hourly rollup identical to the raw rows", async () => {
  await seriesFixture(async (f) => {
    await f.insert(
      ...[0, 1, 2, 3, 4, 5].map((i) => ({
        timestamp: timestamp(`2026-01-01T0${i % 3}:1${i}:00Z`),
        provider: "fixture-lab",
        model: `fixture-model-${i % 2}`,
        inputTokens: String(100 + i),
        outputTokens: String(20 + i),
        totalTokens: String(120 + 2 * i),
        tokenQuality: "complete" as const,
        failed: i === 4,
      })),
    );
    // A second statement that repeats one identity inserts nothing for it and must not count it twice.
    const [first] = await f.insert({ timestamp: timestamp("2026-01-01T05:00:00Z") });
    await f.insert({ ...first, timestamp: timestamp("2026-01-01T05:00:00Z") });
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});
