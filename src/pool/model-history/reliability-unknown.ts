import type { PoolReliability, UnknownOutcomes } from "../../../apps/pool/reliability-contract.ts";
import { digest } from "../backend-users.ts";
import { requestCount } from "./series-coverage.ts";
import { historyTerminalIntegrityVersion, type HistoryDatabase } from "./schema.ts";

const canonicalUuid = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";
/**
 * The request's latest Home attempt, found through the history's request index. Its alias must differ
 * from every caller's, or `id` would compare the attempt with itself.
 */
const latestHome = (id: string) => `SELECT attempt.timestamp,attempt.failed
  FROM basalt_model_requests attempt
  WHERE attempt.pool=$1 AND attempt.source=$2 AND attempt.request_id IS NOT NULL
    AND attempt.request_id=${id}
  ORDER BY attempt.timestamp_exact DESC,attempt.id DESC LIMIT 1`;

/**
 * Real requests in each window whose outcome no record establishes, by why:
 * - pending: a start older than ten minutes with no finish,
 * - unavailable: a finish recorded with an unavailable outcome,
 * - unmatched: a Home row since the terminal cutover with no finished start.
 * A request with a Home attempt is weighed where the window read counts its latest one, already counted
 * there, failed if that attempt failed. Every read goes through a time index or a key.
 */
export async function readUnknownOutcomes(
  db: HistoryDatabase,
  pool: string,
  windows: readonly Pick<PoolReliability, "from" | "to">[],
  proofClassified: boolean,
): Promise<UnknownOutcomes[]> {
  const [first] = windows;
  if (first === undefined) return [];
  const from = windows.reduce((at, window) => (window.from < at ? window.from : at), first.from);
  const to = windows.reduce((at, window) => (window.to > at ? window.to : at), first.to);
  // Proof traffic has its own objective; its lost records cannot hold the real one open.
  const real = (key: string) =>
    proofClassified
      ? `AND NOT EXISTS (SELECT 1 FROM basalt_model_traffic t
          WHERE t.pool=$1 AND t.source=$2 AND t.client_key=${key} AND t.purpose='proof')`
      : "";
  const result = await db.query(
    `WITH ranges(ordinal,from_at,to_at) AS (VALUES ${windows
      .map((_, index) => `(${index},$${6 + index * 2}::timestamptz,$${7 + index * 2}::timestamptz)`)
      .join(",")}),
    unknown(class,id,at,home_at,home_failed) AS (
      SELECT 'pending',s.request_id::text,s.started_at,home.timestamp,home.failed
      FROM basalt_model_terminal_starts s
      LEFT JOIN LATERAL (SELECT true AS found FROM basalt_model_terminal_finishes f
        WHERE f.request_id=s.request_id LIMIT 1) finish ON true
      LEFT JOIN LATERAL (${latestHome("s.request_id::text")}) home ON true
      WHERE s.pool=$1 AND s.started_at >= $4::timestamptz
        AND s.started_at <= $5::timestamptz - interval '10 minutes' AND finish.found IS NULL
        ${real("s.client_key")}
      UNION ALL
      SELECT 'unavailable',s.request_id::text,f.finished_at,home.timestamp,home.failed
      FROM basalt_model_terminal_finishes f
      CROSS JOIN LATERAL (SELECT s.request_id,s.client_key FROM basalt_model_terminal_starts s
        WHERE s.request_id=f.request_id AND s.pool=$1 LIMIT 1) s
      LEFT JOIN LATERAL (${latestHome("s.request_id::text")}) home ON true
      WHERE f.outcome='unavailable' AND f.finished_at >= $4::timestamptz
        AND f.finished_at < $5::timestamptz ${real("s.client_key")}
      UNION ALL
      -- A Home row in the windows also finds a request that finished unavailable outside them.
      SELECT CASE WHEN evidence.outcome='unavailable' THEN 'unavailable' ELSE 'unmatched' END,
        COALESCE(h.request_id,'row:'||h.id),h.timestamp,
        COALESCE(latest.timestamp,h.timestamp),COALESCE(latest.failed,h.failed)
      FROM basalt_model_requests h
      -- Only a canonical lowercase UUID names a start; any other id stays unmatched.
      LEFT JOIN LATERAL (SELECT f.outcome FROM basalt_model_terminal_starts s
        JOIN basalt_model_terminal_finishes f ON f.request_id=s.request_id
        WHERE s.pool=h.pool AND s.request_id=CASE WHEN h.request_id ~ ${canonicalUuid}
          THEN h.request_id::uuid END LIMIT 1) evidence ON true
      LEFT JOIN LATERAL (${latestHome("h.request_id")}) latest ON h.request_id IS NOT NULL
      WHERE h.pool=$1 AND h.source=$2 AND h.timestamp >= $4::timestamptz
        AND h.timestamp < $5::timestamptz
        AND h.timestamp >= (SELECT completed_at FROM basalt_model_history_migrations WHERE name=$3)
        AND (evidence.outcome IS NULL OR evidence.outcome='unavailable') ${real("h.client_key")}
    ), per_request AS (
      SELECT ranges.ordinal,u.id,
        bool_or(u.class='pending') AS pending,
        bool_or(u.class='unavailable') AS unavailable,
        bool_or(u.class='unmatched') AS unmatched,
        bool_or(u.home_at IS NOT NULL) AS counted,
        COALESCE(bool_or(u.home_failed),false) AS failed
      -- The window that counts the request's latest Home attempt weighs it; one with no Home row sits
      -- at its start or finish.
      FROM ranges JOIN unknown u
        ON COALESCE(u.home_at,u.at) >= ranges.from_at AND COALESCE(u.home_at,u.at) < ranges.to_at
      GROUP BY ranges.ordinal,u.id
    )
    SELECT ranges.ordinal,
      count(p.id)::text AS requests,
      count(p.id) FILTER (WHERE p.pending)::text AS pending,
      count(p.id) FILTER (WHERE p.unavailable)::text AS unavailable,
      count(p.id) FILTER (WHERE p.unmatched)::text AS unmatched,
      count(p.id) FILTER (WHERE NOT p.counted)::text AS uncounted,
      count(p.id) FILTER (WHERE NOT (p.counted AND p.failed))::text AS could_fail
    FROM ranges LEFT JOIN per_request p ON p.ordinal=ranges.ordinal
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
      uncounted: requestCount(row?.uncounted ?? "0"),
      couldFail: requestCount(row?.could_fail ?? "0"),
    };
  });
}

type Verdict = "breached" | "ok" | "undecided" | "empty";

/**
 * Unknown outcomes count as possible failures. A request already counted as failed stays one, and one
 * the window never counted adds to its requests. Known failures breach only if they break the target
 * even when every unknown request succeeded; the target holds only if it holds when every unknown
 * request that could fail did. In between, the unknown requests decide it.
 */
export function windowVerdict(window: PoolReliability): Verdict {
  const { requests, failed } = window.real;
  const unknown = window.unknown;
  if (requests === 0 && !unknown?.requests) return "empty";
  const total = BigInt(requests) + BigInt(unknown?.uncounted ?? 0);
  // Compare integer counts: rounding 98.999... to 99 must never suppress an alarm.
  if (BigInt(failed) * 100n > total) return "breached";
  if ((BigInt(failed) + BigInt(unknown?.couldFail ?? 0)) * 100n <= total) return "ok";
  return "undecided";
}

/**
 * A breach in either window wins. Otherwise a window its unknown outcomes decide leaves the
 * objective unavailable, as pending when one of those requests is a start still without a finish.
 */
export function objectiveVerdict(
  hour: PoolReliability,
  day: PoolReliability,
): {
  state: "ok" | "breached" | "no_traffic" | "unavailable";
  reason?: "terminal_collection_pending" | "terminal_collection_unavailable";
} {
  const windows = [hour, day];
  const verdicts = windows.map(windowVerdict);
  if (verdicts.includes("breached")) return { state: "breached" };
  const undecided = windows.filter((_, index) => verdicts[index] === "undecided");
  if (undecided.length > 0)
    return {
      state: "unavailable",
      reason: undecided.some((window) => (window.unknown?.pending ?? 0) > 0)
        ? "terminal_collection_pending"
        : "terminal_collection_unavailable",
    };
  return { state: verdicts.every((verdict) => verdict === "empty") ? "no_traffic" : "ok" };
}
