import { digest } from "../backend-users.ts";
import { poolUsernamePattern } from "./capture-population.ts";
import {
  captureLookbackStart,
  captureSettleHorizon,
  historyCaptureHoursVersion,
} from "./capture-hours-schema.ts";
import { homeHistorySource } from "./home.ts";
import type { ModelRequest } from "./record.ts";
import { historyAppSchemaVersion, type HistoryDatabase } from "./schema.ts";

/**
 * A stored hour count stays true until something changes what it counted. Two things can:
 *
 * - History gains rows for the hour (capture of a late Home row, the late-commit sweep, the
 *   backfill, a local Home import), which changes how many of its usage rows have a request. The
 *   write marks the hour pending in the same statement (capture's backfill and sweep, in one
 *   statement before their inserts), so the plan finds it and the next pass counts it. Only Home's own rows can: the count is of Home usage, and its probe looks for
 *   requests of Home's source.
 * - Home remaps the pool's usage: one of its users is created, renamed or deleted, or one of their
 *   keys is created (Home attributes usage it already holds to a key it repairs), moved or given
 *   another fingerprint. The count is of today's population, so every count of the pools involved
 *   that predates the change is counted again, newest first. Those counts stay meanwhile, so the
 *   summary never falls back to reading the pool row by row while it is counted again.
 *
 * Nothing else is counted again, and nothing on a timer. Not seen: a charge Home writes or changes
 * after its hour settled, naming another user than its key's owner.
 */

/** Which optional parts of the history schema a write fills. */
export async function historyWriteReadiness(db: HistoryDatabase) {
  const result = await db.query(
    "SELECT name FROM basalt_model_history_migrations WHERE name = ANY($1::text[])",
    [[historyAppSchemaVersion, historyCaptureHoursVersion]],
  );
  const names = new Set(result.rows.map((row) => String(row.name)));
  return {
    appAttribution: names.has(historyAppSchemaVersion),
    captureHours: names.has(historyCaptureHoursVersion),
  };
}

let home: Promise<string> | undefined;
/** Home's source digest, as every Home row of history carries it. */
export const homeSource = () => (home ??= digest(homeHistorySource));

/**
 * The hours a mark makes pending: those ending at least an hour before the database's current hour,
 * within the lookback. A count takes an hour three hours after it began, so an insert into a newer
 * hour is in that count already unless its transaction stayed open for an hour; the current hour,
 * which capture writes every page, costs nothing.
 */
const markScope = (hour: string) =>
  `${hour} < date_trunc('hour', transaction_timestamp(), 'UTC') - interval '1 hour'
      AND ${hour} >= ${captureLookbackStart()}`;

/**
 * Writes `-infinity` as the count's time of the pool-hours `w` (pool, hour) names, creating the row
 * if there is none, so a count that read the hour before this write committed finds the row changed
 * and leaves it pending (countBlockStatement). Rows are written in (pool, hour) order, as a count
 * writes its hours, so a mark never waits on a count or another mark in the opposite order. The
 * update is unconditional on purpose: an already pending row must still get a new version, or a
 * count that read it before this write would overwrite it with what it could not see.
 */
const markRows = (w: string) => `INSERT INTO basalt_model_capture_hours AS s
      (pool, hour, usage_requests, uncaptured_requests, checked_at)
    SELECT w.pool, w.hour, 0, 0, '-infinity'::timestamptz FROM ${w} w
    WHERE ${markScope("w.hour")}
    ORDER BY w.pool, w.hour
    ON CONFLICT (pool, hour) DO UPDATE SET checked_at = '-infinity'::timestamptz`;

/**
 * The CTE a history insert appends, named `marked`: it marks pending the pool-hours the insert
 * filled with Home's rows (markRows). `inserted` is the insert's CTE returning pool, timestamp and
 * source; `home` is the parameter holding Home's source digest.
 */
export const markWrittenHours = (inserted: string, home: string) => `marked AS (
    ${markRows(`(
      SELECT DISTINCT i.pool, date_trunc('hour', i.timestamp, 'UTC') AS hour FROM ${inserted} i
      WHERE i.source = ${home}::character(64) AND i.pool IS NOT NULL
    )`)}
    RETURNING 1
  )`;

/**
 * Marks pending, in one ordered statement, the pool-hours of the Home rows in `records`, for a
 * transaction that inserts more than once (capture's backfill and sweep): it marks before its first
 * insert, so it takes its marks before the rollup's rows, in the order a single-statement insert
 * does. The caller passes only rows history lacks; one that turns out to exist costs a recount.
 */
export async function markRequestHours(db: HistoryDatabase, records: readonly ModelRequest[]) {
  const home = await homeSource();
  const hours = new Map<string, { pool: string; hour: string }>();
  for (const row of records)
    if (row.source === home && row.pool) {
      // Every record's time is normalized UTC (record.ts), so its hour is its first 13 characters.
      const hour = `${row.timestamp.slice(0, 13)}:00:00Z`;
      hours.set(`${row.pool}|${hour}`, { pool: row.pool, hour });
    }
  if (!hours.size) return;
  await db.query(
    markRows(`(
      SELECT DISTINCT r.pool, r.hour
      FROM jsonb_to_recordset($1::jsonb) AS r(pool varchar(16), hour timestamptz)
    )`),
    [JSON.stringify([...hours.values()])],
  );
}

/**
 * What the last pass read of Home's mapping: the highest user and key ids, and each ready pool's
 * digest of its users and keys up to them.
 */
export interface CaptureHoursMapping {
  readonly users: string;
  readonly keys: string;
  /** The database's time of that read. */
  readonly at: string;
  readonly pools: Readonly<Record<string, string>>;
}

/**
 * One digest of a set of rows, whatever their order: the sum of their hashes and their number. A
 * changed, added or removed row changes it (up to a hash collision), without sorting the rows or
 * building one string of them: a pool's keys include every key Basalt ever minted for it, since
 * Home revokes a key by soft delete.
 */
const digestOf = (row: string, filter?: string) => {
  const only = filter ? ` FILTER (WHERE ${filter})` : "";
  return `coalesce(sum(hashtextextended(${row}, 0)::numeric)${only}, 0) || '/' || count(*)${only}`;
};
const userRow = "u.id || ':' || u.username";
const keyRow = "k.id || ':' || k.user_id || ':' || coalesce(k.diagnostic_fingerprint, '')";

/**
 * One pass over Home's users and keys, however many pools there are. For each ready pool: the
 * digests of its users (id and name) and their keys (id, owner and fingerprint) up to the last
 * pass's highest ids `$2` and `$3` (`before`) and over all of them (`now`, kept for the next pass),
 * keys revoked over an hour before the read left out of both: `before` by the last read's time
 * `$5`, `now` by this one's, so a key revoked between two reads is in both and the digests of an
 * unchanged pool agree. Every app request and probe leaves a revoked key behind, so this keeps the
 * hashing and summing to the active keys and the recently revoked ones; the scan itself may still
 * read every key row, since keys created since the last read are kept whatever their state. Not
 * seen: an edit to a key revoked before the last read, which Home's API cannot make.
 * and whether a key created since attributes successful usage Home held before the key existed and
 * before the settle horizon (`repaired`, asked only with `$4`): one probe each of Home's index of
 * successful usage by key and time (idx_usage_key_success_time_v1). Keys Basalt mints for every app
 * request and probe have no usage older than themselves, so they count nothing again. A key's
 * deleted_at is left out: a revoked key's usage stays its owner's. The highest ids are read even
 * with no pool ready, so a pool that becomes ready later probes only the keys created after.
 */
const mappingRead = `WITH members AS (
    SELECT right(a.username, 16) AS pool, a.id, a.username FROM "user" a WHERE a.username ~ $1
  ), users AS (
    SELECT u.pool, ${digestOf(userRow, "u.id <= $2::bigint")} AS before, ${digestOf(userRow)} AS now
    FROM members u GROUP BY u.pool
  ), keys AS (
    SELECT m.pool,
      ${digestOf(keyRow, "k.id <= $3::bigint AND (k.deleted_at IS NULL OR k.deleted_at > $5::timestamptz - interval '1 hour')")} AS before,
      ${digestOf(keyRow, "k.deleted_at IS NULL OR k.deleted_at > transaction_timestamp() - interval '1 hour'")} AS now,
      bool_or(k.id > $3::bigint AND $4::boolean AND EXISTS (
        SELECT 1 FROM usage x WHERE x.api_key = k.diagnostic_fingerprint AND x.failed = false
          AND x.timestamp < LEAST(${captureSettleHorizon}, k.created_at))) AS repaired
    FROM members m JOIN api_key k ON k.user_id = m.id
    WHERE k.deleted_at IS NULL
      OR k.deleted_at > LEAST($5::timestamptz, transaction_timestamp()) - interval '1 hour'
      OR k.id > $3::bigint
    GROUP BY m.pool
  ), maxima AS (
    SELECT (SELECT coalesce(max(id), 0) FROM "user")::text AS users,
      (SELECT coalesce(max(id), 0) FROM api_key)::text AS keys,
      to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
  )
  SELECT x.users, x.keys, x.at, r.pool,
    coalesce(u.before, '0/0') || '|' || coalesce(k.before, '0/0') AS before,
    coalesce(u.now, '0/0') || '|' || coalesce(k.now, '0/0') AS now,
    coalesce(k.repaired, false) AS repaired
  FROM maxima x LEFT JOIN basalt_model_usage_people_ready r ON true
  LEFT JOIN users u ON u.pool = r.pool LEFT JOIN keys k ON k.pool = r.pool
  ORDER BY r.pool`;

const bigint = 9_223_372_036_854_775_807n;
const counter = (value: unknown) =>
  typeof value === "string" && /^[0-9]{1,19}$/.test(value) && BigInt(value) <= bigint;
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const mappingOf = (value: unknown): CaptureHoursMapping | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { users, keys, at, pools } = value as Partial<CaptureHoursMapping>;
  return counter(users) &&
    counter(keys) &&
    instant(at) &&
    typeof pools === "object" &&
    pools !== null &&
    !Array.isArray(pools) &&
    Object.values(pools).every((digest) => typeof digest === "string")
    ? (value as CaptureHoursMapping)
    : undefined;
};

/**
 * The ready pools to count again since `previous`, the mapping to keep for the next pass, and the
 * database's time of this read: counts taken before it are counted again.
 *
 * A pool is counted again when a user or key that existed at the last pass changed (renamed,
 * deleted, a key moved or given another fingerprint), or when a key created since attributes usage
 * Home already held (a key Home repaired). Home's ids are serial primary keys (`api_key.id` is
 * `primaryKey;autoIncrement`); the rule's correctness does not rest on that, since any id up to the
 * last maximum that appears, disappears or changes changes `before`, so a reused or late-committing
 * id only counts a pool again needlessly. Not seen: a repaired key whose past usage all failed,
 * which Home's index leaves out. With no mapping kept (the first pass, or a lost or malformed state)
 * any count may predate a change, so every pool is counted again once.
 */
export async function remapCaptureHours(db: HistoryDatabase, previous: unknown) {
  const known = mappingOf(previous);
  const rows = (
    await db.query(mappingRead, [
      poolUsernamePattern("[0-9a-f]{16}"),
      known?.users ?? "0",
      known?.keys ?? "0",
      known !== undefined,
      known?.at ?? "1970-01-01T00:00:00Z",
    ])
  ).rows;
  const top = rows[0]!;
  const ready = rows.filter((row) => typeof row.pool === "string");
  const mapping: CaptureHoursMapping = {
    users: String(top.users),
    keys: String(top.keys),
    at: String(top.at),
    pools: Object.fromEntries(ready.map((row) => [String(row.pool), String(row.now)])),
  };
  const remapped = ready
    .filter((row) => {
      const was = known?.pools[String(row.pool)];
      return !known || row.repaired === true || (was !== undefined && was !== String(row.before));
    })
    .map((row) => String(row.pool));
  return { mapping, remapped, at: String(top.at) };
}
