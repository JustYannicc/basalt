import { digest } from "../backend-users.ts";
import { poolUsernamePattern } from "./capture-population.ts";
import { historyCaptureHoursVersion } from "./capture-hours-schema.ts";
import { homeHistorySource } from "./home.ts";
import { historyAppSchemaVersion, type HistoryDatabase } from "./schema.ts";

/**
 * A stored hour count stays true until something changes what it counted. Two things can:
 *
 * - History gains rows for the hour (capture of a late Home row, the late-commit sweep, the
 *   backfill, a local Home import), which changes how many of its usage rows have a request. The
 *   write deletes the hour's count in the same statement, so the plan finds the hour pending and
 *   the next pass counts it. Only Home's own rows can: the count is of Home usage, and its probe
 *   looks for requests of Home's source.
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
 * The CTE a history insert appends, named `marked`: it deletes the stored counts of the pool-hours
 * the insert filled with Home's rows. `inserted` is the insert's CTE, returning pool, timestamp and
 * source; `home` is the parameter that holds Home's source digest.
 */
export const markWrittenHours = (inserted: string, home: string) => `marked AS (
    DELETE FROM basalt_model_capture_hours s USING (
      SELECT DISTINCT i.pool, date_trunc('hour', i.timestamp, 'UTC') AS hour FROM ${inserted} i
      WHERE i.source = ${home}::character(64) AND i.pool IS NOT NULL
    ) w WHERE s.pool = w.pool AND s.hour = w.hour RETURNING 1
  )`;

/** Each ready pool's digest of its Home users and the keys they own, as the last pass read it. */
export type CaptureHoursMapping = Readonly<Record<string, string>>;

/**
 * Each ready pool's users (id and name) and their keys (id, owner and fingerprint), as one digest a
 * pool. One fixed pattern finds every pool's users and their name's last 16 characters name the
 * pool, so the read is one pass over Home's users and keys however many pools there are.
 */
const mappingRead = `WITH members AS (
    SELECT right(a.username, 16) AS pool, a.id, a.username FROM "user" a WHERE a.username ~ $1
  ), owned AS (
    SELECT m.pool, string_agg(m.id || ':' || m.username, ',' ORDER BY m.id) AS users
    FROM members m GROUP BY m.pool
  ), held AS (
    SELECT m.pool, string_agg(k.id || ':' || k.user_id || ':' || coalesce(k.diagnostic_fingerprint, ''),
      ',' ORDER BY k.id) AS keys
    FROM members m JOIN api_key k ON k.user_id = m.id GROUP BY m.pool
  )
  SELECT r.pool, md5(coalesce(o.users, '') || '|' || coalesce(h.keys, '')) AS digest,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
  FROM basalt_model_usage_people_ready r
  LEFT JOIN owned o ON o.pool = r.pool LEFT JOIN held h ON h.pool = r.pool
  ORDER BY r.pool`;

const mappingOf = (value: unknown): CaptureHoursMapping | undefined =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((digest) => typeof digest === "string")
    ? (value as CaptureHoursMapping)
    : undefined;

/**
 * The ready pools whose users or keys Home changed since `previous`, the mapping to keep for the
 * next pass, and the database's time of this read: counts taken before it are counted again. With no
 * mapping kept (the first pass, or a lost or malformed state), any count may predate a change, so
 * every pool is counted again once. A pool that became ready since has only counts taken since.
 */
export async function remapCaptureHours(db: HistoryDatabase, previous: unknown) {
  const rows = (await db.query(mappingRead, [poolUsernamePattern("[0-9a-f]{16}")])).rows;
  const known = mappingOf(previous);
  const mapping: CaptureHoursMapping = Object.fromEntries(
    rows.map((row) => [String(row.pool), String(row.digest)]),
  );
  const remapped = Object.keys(mapping).filter(
    (pool) => !known || (known[pool] !== undefined && known[pool] !== mapping[pool]),
  );
  return { mapping, remapped, at: rows[0] ? String(rows[0].at) : undefined };
}
