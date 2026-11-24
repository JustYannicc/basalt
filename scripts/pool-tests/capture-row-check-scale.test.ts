import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import {
  homeCaptureCoverage,
  isRowCheck,
  rowCheckStatement,
} from "../../src/pool/model-history/capture-coverage.ts";
import {
  captureHoursCountLimitMs,
  countBlockStatement,
} from "../../src/pool/model-history/capture-hours-count.ts";
import { poolUsernamePattern } from "../../src/pool/model-history/capture-population.ts";
import { captureHoursLookbackHours } from "../../src/pool/model-history/capture-hours-plan.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { captureFixture, fillByTicks, hourMs } from "./capture-hours-fixture.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryPrices } from "./usage-summary-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];
const dayMs = 24 * hourMs;
const requests = Number(process.env.POOL_TEST_CAPTURE_REQUESTS ?? 2_290_000);
const usage = Number(process.env.POOL_TEST_CAPTURE_USAGE ?? 600_000);
/** A busy hour's Home usage rows, all of one pool. */
const dense = Number(process.env.POOL_TEST_CAPTURE_DENSE ?? 4_000);
const days = 86;

/**
 * A large dataset: by default 2.29 M requests across four pools over 86 days, the Home usage rows of
 * `usage` of them (the rest are imports, with no usage row). Every pool's users have their own key.
 */
async function largeDataset(f: Fixture, now: number) {
  const c = await captureFixture(f);
  const keys = [c.fingerprint, c.otherKey];
  const ids = [c.poolId, c.otherId];
  for (const [n, name] of ["capture-scale-pool-3", "capture-scale-pool-4"].entries()) {
    const key = `sha256:${String(n + 3).repeat(64)}`;
    await f.db.query('INSERT INTO "user" VALUES ($1,$2)', [
      20 + n,
      await backendUserName("fixture-person-1", name),
    ]);
    await f.db.query("INSERT INTO api_key (id,diagnostic_fingerprint,user_id) VALUES ($1,$2,$1)", [
      20 + n,
      key,
    ]);
    keys.push(key);
    ids.push((await digest(name)).slice(0, 16));
  }
  const imports = await digest("capture-scale-import");
  const start = now - days * dayMs;
  const span = days * 86_400;
  await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER USER");
  // Native requests, each with its Home usage row, spread evenly over the 86 days, pools in turn.
  await f.db.query(
    `INSERT INTO basalt_model_requests (id,source,source_record,timestamp,timestamp_exact,pool,
      provider,model,token_quality,failed,cost_basis,ingested_at,attribution)
    SELECT encode(sha256(convert_to('["'||$1::text||'","'||r||'"]','UTF8')),'hex'), $1, r, t,
      to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'000Z', ($2::text[])[1 + n % 4],
      'fixture-lab', 'fixture-model', 'complete', false, 'unpriced', t, 'key-at-capture'
    FROM generate_series(1,$4::int) n
    CROSS JOIN LATERAL (SELECT encode(sha256(convert_to('["usage","'||n||'"]','UTF8')),'hex') AS r,
      $3::timestamptz + (n::float8 / $4 * $5) * interval '1 second' AS t) x`,
    [c.source, ids, new Date(start).toISOString(), usage, span],
  );
  await f.db.query(
    `INSERT INTO usage (id,timestamp,api_key)
    SELECT n, $1::timestamptz + (n::float8 / $2 * $3) * interval '1 second', ($4::text[])[1 + n % 4]
    FROM generate_series(1,$2::int) n`,
    [new Date(start).toISOString(), usage, span, keys],
  );
  // Imported requests: no usage row.
  await f.db.query(
    `INSERT INTO basalt_model_requests (id,source,source_record,timestamp,timestamp_exact,pool,
      provider,model,token_quality,failed,cost_basis,ingested_at,attribution)
    SELECT encode(sha256(convert_to('["'||$1::text||'","'||r||'"]','UTF8')),'hex'), $1, r, t,
      to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'000Z', ($2::text[])[1 + n % 4],
      'fixture-lab', 'fixture-model', 'complete', false, 'unpriced', t, 'unknown'
    FROM generate_series(1,$4::int) n
    CROSS JOIN LATERAL (SELECT encode(sha256(convert_to('["import","'||n||'"]','UTF8')),'hex') AS r,
      $3::timestamptz + (n::float8 / $4 * $5) * interval '1 second' AS t) x`,
    [imports, ids, new Date(start).toISOString(), requests - usage, span],
  );
  await f.db.query("ALTER TABLE basalt_model_requests ENABLE TRIGGER USER");
  const forward = Number((await f.db.query("SELECT max(id)::int AS id FROM usage")).rows[0]!.id);
  await c.cursor(forward);
  await c.ready();
  await c.analyze();
  return c;
}

/** One summary of the pool's last week, with each step's time and the statements it ran. */
async function measure(f: Fixture, c: Awaited<ReturnType<typeof largeDataset>>, now: number) {
  const ran: { text: string; values?: unknown[]; ms: number }[] = [];
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const started = performance.now();
      try {
        return await f.db.query(text, values);
      } finally {
        ran.push({ text, values, ms: performance.now() - started });
      }
    },
  };
  const steps: { step: string; at: number }[] = [];
  const started = performance.now();
  const result = await poolUsageSummary(
    db,
    {
      pool,
      from: new Date(now - 7 * dayMs).toISOString(),
      to: new Date(now).toISOString(),
      authority: c.authority,
    },
    async () => ({ prices: summaryPrices, issues: [] }),
    now,
    (step) => steps.push({ step, at: performance.now() }),
  );
  const total = performance.now() - started;
  const capture = steps.findIndex((entry) => entry.step === "capture");
  const captureMs = steps[capture + 1]!.at - steps[capture]!.at;
  const check = ran.find((entry) => isRowCheck(entry.text));
  return { result, total, captureMs, check };
}

async function explain(f: Fixture, text: string, values: unknown[]) {
  await f.db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    return (await f.db.query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values)).rows
      .map((row) => String(row["QUERY PLAN"]))
      .join("\n");
  } finally {
    await f.db.query("ROLLBACK");
  }
}

test(
  "the summary's capture step at a large size: nothing, half and every hour counted",
  {
    skip: !process.env.POOL_TEST_CAPTURE_SCALE && "set POOL_TEST_CAPTURE_SCALE=1 to measure",
    timeout: 3 * 3_600_000,
  },
  async () => {
    await seriesFixture(async (f) => {
      const now = Date.now();
      const c = await largeDataset(f, now);
      const report = async (label: string) => {
        await measure(f, c, now);
        const run = await measure(f, c, now);
        console.log(
          `CASE ${label}: capture step ${run.captureMs.toFixed(0)} ms, summary ${run.total.toFixed(0)} ms, status ${run.result.homeCapture.status}, partial ${run.result.partial}, row check ${run.check ? `${run.check.ms.toFixed(0)} ms over ${(run.check.values!.length - 3) / 2} ranges` : "not run"}`,
        );
        if (run.check)
          console.log(
            `PLAN ${label}\n${await explain(f, run.check.text, run.check.values!)}\nEND PLAN`,
          );
        return run;
      };
      const nothing = await report("nothing counted");
      // The statement before v17 over the same ranges, for the comparison.
      const ranges = nothing.check!.values!.slice(3);
      const seen: { text: string; values?: unknown[] }[] = [];
      await f.db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        await homeCaptureCoverage(
          {
            query: (text, values) => {
              seen.push({ text, values });
              return f.db.query(text, values);
            },
          },
          c.poolId,
          c.source,
          String(ranges[0]),
          String(ranges.at(-1)),
        );
      } finally {
        await f.db.query("ROLLBACK");
      }
      const before = seen.find((entry) => entry.text.includes("u.timestamp >= $2::timestamptz"))!;
      console.log(
        `PLAN before v17, ${String(ranges[0])} to ${String(ranges.at(-1))}\n${await explain(f, before.text, before.values!)}\nEND PLAN`,
      );
      await fillByTicks(f.db, 43 * 24);
      await report("half counted");
      await fillByTicks(f.db, captureHoursLookbackHours);
      const all = await report("all counted");
      assert.equal(all.result.homeCapture.status, "available");

      // A busy hour: by default 4,000 native requests of one pool in one hour,
      // each with its Home usage row, written as the capture writes them (triggers on).
      const hour = Math.floor((now - 20 * hourMs) / hourMs) * hourMs;
      const firstId = Number(
        (await f.db.query("SELECT max(id)::int AS id FROM usage")).rows[0]!.id,
      );
      await f.db.query(
        `INSERT INTO basalt_model_requests (id,source,source_record,timestamp,timestamp_exact,pool,
          provider,model,token_quality,failed,cost_basis,ingested_at,attribution)
        SELECT encode(sha256(convert_to('["'||$1::text||'","'||r||'"]','UTF8')),'hex'), $1, r, t,
          to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'000Z', $2, 'fixture-lab',
          'fixture-model', 'complete', false, 'unpriced', t, 'key-at-capture'
        FROM generate_series(1,$4::int) k
        CROSS JOIN LATERAL (
          SELECT encode(sha256(convert_to('["usage","'||($5::int + k)||'"]','UTF8')),'hex') AS r,
            $3::timestamptz + (k::float8 / $4 * 3599) * interval '1 second' AS t) x`,
        [c.source, c.poolId, new Date(hour).toISOString(), dense, firstId],
      );
      await f.db.query(
        `INSERT INTO usage (id,timestamp,api_key)
        SELECT $1::int + k, $2::timestamptz + (k::float8 / $3 * 3599) * interval '1 second', $4
        FROM generate_series(1,$3::int) k`,
        [firstId, new Date(hour).toISOString(), dense, c.fingerprint],
      );
      await c.analyze();
      const values = [
        c.poolId,
        new Date(hour).toISOString(),
        new Date(hour + hourMs).toISOString(),
        poolUsernamePattern(c.poolId),
        c.source,
      ];
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        await f.db.query("BEGIN");
        try {
          await f.db.query(countBlockStatement, values);
        } finally {
          await f.db.query("ROLLBACK");
        }
        console.log(
          `CASE busy hour count, ${dense} usage rows, run ${run + 1}: ${(performance.now() - started).toFixed(0)} ms (limit ${captureHoursCountLimitMs} ms)`,
        );
      }
      await f.db.query("BEGIN");
      try {
        const plan = (await f.db.query(`EXPLAIN (ANALYZE, BUFFERS) ${countBlockStatement}`, values))
          .rows;
        console.log(
          `PLAN busy hour count\n${plan.map((row) => String(row["QUERY PLAN"])).join("\n")}\nEND PLAN`,
        );
      } finally {
        await f.db.query("ROLLBACK");
      }
      const busy = [poolUsernamePattern(c.poolId), c.poolId, c.source, values[1], values[2]];
      console.log(
        `PLAN busy hour row check\n${await explain(f, rowCheckStatement(1), busy)}\nEND PLAN`,
      );
    });
  },
);
