import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import {
  homeCaptureCoverage,
  isRowCheck,
  rowCheckRanges,
} from "../../src/pool/model-history/capture-coverage.ts";
import { captureHoursTick } from "../../src/pool/model-history/capture-hours-auto.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import {
  planUsageRollup,
  runUsageRollup,
} from "../../src/pool/model-history/usage-rollup-backfill.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryCounters, summaryFixture } from "./usage-summary-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];
export const hourMs = 3_600_000;
/** The other pool, with a backend user of its own. */
export const otherPool = "capture-hours-other-pool";

/** The hour `n` hours after the fixture's first: whole UTC hours two days before now. */
export const base = Math.floor((Date.now() - 48 * hourMs) / hourMs) * hourMs;
export const at = (hours: number, ms = 0) => new Date(base + hours * hourMs + ms).toISOString();
export const hourKey = (hours: number) => at(hours).replace(".000Z", "Z");

export const memoryStorage = () => {
  const stored = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
  };
};

/** Statements in the order they ran. */
export function recording(db: HistoryDatabase) {
  const seen: { text: string; values?: unknown[] }[] = [];
  return {
    seen,
    db: {
      query: (text: string, values?: unknown[]) => {
        seen.push({ text, values });
        return db.query(text, values);
      },
    } satisfies HistoryDatabase,
    /** The ranges the per-row check read, or undefined when it did not run. */
    ranges: () => {
      const read = seen.filter((entry) => isRowCheck(entry.text));
      return read.length ? read.flatMap((entry) => rowCheckRanges(entry.values!)) : undefined;
    },
  };
}

/** The pool's Home tables, users and requests, and helpers to make it ready and counted. */
export async function captureFixture(f: Fixture) {
  const fixture = await summaryFixture(f);
  const poolId = (await digest(pool)).slice(0, 16);
  const otherId = (await digest(otherPool)).slice(0, 16);
  const otherKey = `sha256:${"b".repeat(64)}`;
  await f.db.query('INSERT INTO "user" VALUES (8,$1)', [
    await backendUserName("fixture-person-1", otherPool),
  ]);
  await f.db.query("INSERT INTO api_key (id,diagnostic_fingerprint,user_id) VALUES (10,$1,8)", [
    otherKey,
  ]);
  let id = 1_000;
  /** A Home usage row of the pool's user and its captured request; of the other pool's, with `other`. */
  const native = async (time: string, other = false) => {
    if (!other) return fixture.native(++id, time);
    await f.insert({
      ...summaryCounters,
      source: fixture.source,
      pool: otherId,
      timestamp: timestamp(time),
      sourceRecord: await digest(JSON.stringify(["usage", String(++id)])),
    });
    await f.db.query("INSERT INTO usage (id,timestamp,api_key) VALUES ($1,$2,$3)", [
      id,
      time,
      otherKey,
    ]);
  };
  /** A Home usage row with no request. */
  const usage = async (time: string, key = fixture.fingerprint) => {
    await f.db.query("INSERT INTO usage (id,timestamp,api_key) VALUES ($1,$2,$3)", [
      ++id,
      time,
      key,
    ]);
    return id;
  };
  const ready = async () => {
    const { plan } = await planUsageRollup(f.db);
    for (let run = 0; run < 50; run++)
      if ((await runUsageRollup(f.db, plan, 60_000)).status === "complete") return;
    throw new Error("the v16 backfill did not finish");
  };
  const storage = memoryStorage();
  const fill = (lookback = lookbackHours) => fillByTicks(f.db, lookback, storage);
  /** The counted capture check, in a read-only snapshot as the summary runs it. */
  const coverage = async (from: string, to: string) => {
    const read = recording(f.db);
    await f.db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const result = await homeCaptureCoverage(read.db, poolId, fixture.source, from, to, true);
      return { incomplete: result.incompleteHours, ranges: read.ranges() };
    } finally {
      await f.db.query("ROLLBACK");
    }
  };
  const stored = async (pool = poolId) =>
    Object.fromEntries(
      (
        await f.db.query(
          `SELECT to_char(hour AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour,
          usage_requests FROM basalt_model_capture_hours WHERE pool=$1 ORDER BY hour`,
          [pool],
        )
      ).rows.map((row) => [String(row.hour), Number(row.usage_requests)]),
    );
  return {
    ...fixture,
    poolId,
    otherId,
    otherKey,
    native,
    usage,
    ready,
    storage,
    fill,
    coverage,
    stored,
  };
}

/**
 * Moves the database's clock for this fixture's session to `at`: the schema's own `now()` and
 * `transaction_timestamp()`, which every capture-hour statement reads, are Postgres's shifted by
 * the same amount, and the schema is searched before pg_catalog. Real time still passes.
 */
export async function clockAt(f: Fixture, at: number) {
  const offset = Math.round(at - Date.now());
  for (const name of ["now", "transaction_timestamp"])
    await f.db.query(
      `CREATE OR REPLACE FUNCTION ${f.schema}.${name}() RETURNS timestamptz LANGUAGE sql STABLE
      AS $$ SELECT pg_catalog.${name}() + ${offset} * interval '1 millisecond' $$`,
    );
  await f.db.query(`SET search_path TO ${f.schema}, pg_catalog`);
}

/**
 * Where the database clock can stand against the six-hour blocks the tick counts: the settle
 * horizon 0 to 5 hours into a block, so the newest block holds every count of settled hours, and
 * five minutes either side of the horizon reaching a block that starts at a UTC midnight. A test
 * that runs at each of them can't pass at one hour of the day and fail at another.
 */
export function blockPositions(now = Date.now()) {
  const midnight = Math.floor((now - 8 * hourMs) / (24 * hourMs)) * 24 * hourMs;
  const edge = midnight + 2 * hourMs;
  return [
    ...[0, 1, 2, 3, 4, 5].map((hours) => ({
      label: `the horizon ${hours} h into a block`,
      at: edge + hours * hourMs + 40 * 60_000,
    })),
    { label: "five minutes before the horizon reaches a midnight block", at: edge - 300_000 },
    { label: "five minutes after the horizon reaches a midnight block", at: edge + 300_000 },
  ];
}

/** The fixture's lookback: three days, which covers its hours, so a fill takes few counts. */
export const lookbackHours = 72;

/** Every ready pool's counts over `lookback` hours, by ticks alone. */
export async function fillByTicks(
  db: HistoryDatabase,
  lookback: number,
  storage = memoryStorage(),
) {
  for (let tick = 0; tick < 200; tick++) {
    const state = await captureHoursTick(storage, (work) => work(db), {
      bounds: { lookbackHours: lookback, hourMs: Number.POSITIVE_INFINITY },
    });
    if (state.lastStop === "complete" && state.pendingHours === 0) return state;
  }
  throw new Error("the tick did not fill the counts");
}
