import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { homeCaptureCoverage } from "../../src/pool/model-history/capture-coverage.ts";
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
      const read = seen.filter((entry) => entry.text.includes("AS w(f text, t text)"));
      return read.length
        ? read.flatMap(
            (entry) => JSON.parse(String(entry.values![1])) as { f: string; t: string }[],
          )
        : undefined;
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
  const fill = async () => {
    for (let tick = 0; tick < 20; tick++) {
      const state = await captureHoursTick(storage, (work) => work(f.db));
      if (state.lastStop === "complete" && state.totalPendingHours === 0) return state;
    }
    throw new Error("the tick did not fill the pool");
  };
  const coverage = async (from: string, to: string) => {
    const read = recording(f.db);
    const result = await homeCaptureCoverage(read.db, poolId, fixture.source, from, to, true);
    return { incomplete: result.incompleteHours, ranges: read.ranges() };
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
 * Fills a pool's counts by its own tick, and counts its hours from `since` up to its first native
 * hour as empty, as a pool whose history spans its window has them.
 */
export async function countedSince(db: HistoryDatabase, poolId: string, since: string) {
  const storage = memoryStorage();
  for (let tick = 0; ; tick++) {
    if (tick >= 20) throw new Error("the counts did not fill");
    const state = await captureHoursTick(storage, (work) => work(db));
    if (state.lastStop === "complete" && state.totalPendingHours === 0) break;
  }
  await db.query(
    `INSERT INTO basalt_model_capture_hours (pool,hour,usage_requests,checked_at)
    SELECT $1, h, 0, h + interval '3 hours' FROM generate_series($2::timestamptz,
      (SELECT min(hour) FROM basalt_model_capture_hours WHERE pool=$1) - interval '1 hour',
      interval '1 hour') h
    ON CONFLICT DO NOTHING`,
    [poolId, since],
  );
}
