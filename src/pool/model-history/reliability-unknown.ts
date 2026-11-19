import type { PoolReliability, UnknownOutcomes } from "../../../apps/pool/reliability-contract.ts";
import { digest } from "../backend-users.ts";
import { requestCount } from "./series-coverage.ts";
import { historyTerminalIntegrityVersion, type HistoryDatabase } from "./schema.ts";

/**
 * Requests in each window whose outcome no record establishes, by why:
 * - pending: a start older than ten minutes with no finish,
 * - unavailable: a finish recorded with an unavailable outcome,
 * - unmatched: a Home row since the terminal cutover with no finished start.
 * A request in two classes counts once in `requests`. Each lookup goes through a key or a time index.
 */
export async function readUnknownOutcomes(
  db: HistoryDatabase,
  pool: string,
  windows: readonly Pick<PoolReliability, "from" | "to">[],
  to: string,
): Promise<UnknownOutcomes[]> {
  if (windows.length === 0) return [];
  const from = windows.reduce((at, window) => (window.from < at ? window.from : at), to);
  const result = await db.query(
    `WITH ranges(ordinal,from_at,to_at) AS (VALUES ${windows
      .map((_, index) => `(${index},$${6 + index * 2}::timestamptz,$${7 + index * 2}::timestamptz)`)
      .join(",")}),
    unknown(class,id,at) AS (
      SELECT 'pending',s.request_id::text,s.started_at FROM basalt_model_terminal_starts s
      WHERE s.pool=$1 AND s.started_at >= $4::timestamptz
        AND s.started_at <= $5::timestamptz - interval '10 minutes'
        AND NOT EXISTS (SELECT 1 FROM basalt_model_terminal_finishes f WHERE f.request_id=s.request_id)
      UNION ALL
      SELECT 'unavailable',s.request_id::text,f.finished_at FROM basalt_model_terminal_finishes f
      JOIN basalt_model_terminal_starts s ON s.request_id=f.request_id
      WHERE s.pool=$1 AND f.outcome='unavailable'
        AND f.finished_at >= $4::timestamptz AND f.finished_at < $5::timestamptz
      UNION ALL
      SELECT 'unmatched',COALESCE(h.request_id,'row:'||h.id),h.timestamp
      FROM basalt_model_requests h, basalt_model_history_migrations m
      WHERE m.name=$3 AND h.pool=$1 AND h.source=$2
        AND h.timestamp >= GREATEST($4::timestamptz, m.completed_at) AND h.timestamp < $5::timestamptz
        -- Only a canonical lowercase UUID names a start; any other id stays unmatched.
        AND NOT EXISTS (
          SELECT 1 FROM basalt_model_terminal_starts s
          JOIN basalt_model_terminal_finishes f USING (request_id)
          WHERE s.pool=h.pool AND s.request_id=CASE
            WHEN h.request_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN h.request_id::uuid END
        )
    )
    SELECT ranges.ordinal,
      count(DISTINCT u.id)::text AS requests,
      count(DISTINCT u.id) FILTER (WHERE u.class='pending')::text AS pending,
      count(DISTINCT u.id) FILTER (WHERE u.class='unavailable')::text AS unavailable,
      count(DISTINCT u.id) FILTER (WHERE u.class='unmatched')::text AS unmatched
    FROM ranges LEFT JOIN unknown u ON u.at >= ranges.from_at AND u.at < ranges.to_at
    GROUP BY ranges.ordinal ORDER BY ranges.ordinal`,
    [
      (await digest(pool)).slice(0, 16),
      await digest("home-local-v1"),
      historyTerminalIntegrityVersion,
      from,
      to,
      ...windows.flatMap((window) => [window.from, window.to]),
    ],
  );
  return windows.map((_, index) => {
    const row = result.rows.find((value) => Number(value.ordinal) === index);
    return {
      requests: requestCount(row?.requests ?? "0"),
      pending: requestCount(row?.pending ?? "0"),
      unavailable: requestCount(row?.unavailable ?? "0"),
      unmatched: requestCount(row?.unmatched ?? "0"),
    };
  });
}

type Verdict = "breached" | "ok" | "undecided" | "empty";

/**
 * Unknown outcomes count as possible failures. Known failures alone breach only if they break the
 * target even when every unknown request succeeded; the target holds only if it holds when every
 * unknown request failed. In between, the unknown requests decide it, and the figure cannot tell.
 */
export function windowVerdict(window: PoolReliability): Verdict {
  const { requests, failed } = window.real;
  const unknown = BigInt(window.unknown?.requests ?? 0);
  if (requests === 0 && unknown === 0n) return "empty";
  // Compare integer counts: rounding 98.999... to 99 must never suppress an alarm.
  if (BigInt(failed) * 100n > BigInt(requests) + unknown) return "breached";
  if ((BigInt(failed) + unknown) * 100n <= BigInt(requests)) return "ok";
  return "undecided";
}
