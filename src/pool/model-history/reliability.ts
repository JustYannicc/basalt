import type {
  PoolReliability,
  ReliabilityCounts,
} from "../../../apps/pool/reliability-contract.ts";
import { digest } from "../backend-users.ts";
import { historyTerminalIntegrityVersion, type HistoryDatabase } from "./schema.ts";
import { HistoryInputError, timestamp } from "./record.ts";
import { requestCount } from "./series-coverage.ts";

export async function terminalCollectionReady(db: HistoryDatabase): Promise<boolean> {
  const catalog = await db.query(`SELECT
      to_regclass('basalt_model_terminal_starts') IS NOT NULL
      AND to_regclass('basalt_model_terminal_finishes') IS NOT NULL
      AND to_regclass('basalt_model_history_migrations') IS NOT NULL AS ready`);
  if (catalog.rows[0]?.ready !== true) return false;
  const marker = await db.query("SELECT 1 FROM basalt_model_history_migrations WHERE name=$1", [
    historyTerminalIntegrityVersion,
  ]);
  return marker.rows.length === 1;
}

export async function readPoolReliability(
  db: HistoryDatabase,
  pool: string,
  from: string,
  to: string,
  terminalReadyOverride?: boolean,
): Promise<PoolReliability> {
  const [result] = await readPoolReliabilityWindows(
    db,
    pool,
    [{ from, to }],
    terminalReadyOverride,
  );
  if (result === undefined) throw new HistoryInputError();
  return result;
}

export async function readPoolReliabilityWindows(
  db: HistoryDatabase,
  pool: string,
  windows: readonly Pick<PoolReliability, "from" | "to">[],
  terminalReadyOverride?: boolean,
): Promise<PoolReliability[]> {
  if (windows.length === 0) return [];
  const ranges = windows.map(({ from, to }) => {
    const start = timestamp(from),
      end = timestamp(to);
    if (start >= end || Date.parse(end) - Date.parse(start) > 90 * 86_400_000 + 3_600_000)
      throw new HistoryInputError();
    return { from: start, to: end };
  });
  const [first] = ranges;
  if (first === undefined) throw new HistoryInputError();
  const start = ranges.reduce((at, range) => (range.from < at ? range.from : at), first.from);
  const end = ranges.reduce((at, range) => (range.to > at ? range.to : at), first.to);
  if (Date.parse(end) - Date.parse(start) > 90 * 86_400_000 + 3_600_000)
    throw new HistoryInputError();
  const sources = await Promise.all([digest("home-local-v1"), digest("pool-gateway-v1")]);
  const terminalReady = terminalReadyOverride ?? (await terminalCollectionReady(db));
  const ready =
    (await db.query("SELECT to_regclass('basalt_model_traffic') IS NOT NULL AS ready")).rows[0]
      ?.ready === true;
  const isProof = ready
    ? `EXISTS (SELECT 1 FROM basalt_model_traffic t
    WHERE t.pool=r.pool AND t.source=r.source AND t.client_key=r.client_key AND t.purpose='proof')`
    : "false";
  const finalAttempt = terminalReady
    ? "(COALESCE(last.id=r.id,false) AND f.outcome IS NOT NULL AND f.outcome <> 'unavailable')"
    : "false";
  const terminalFailure = terminalReady
    ? "(COALESCE(last.id=r.id,false) AND COALESCE(f.outcome IN ('truncated','client_closed','provider_failed'),false))"
    : "false";
  const statusCode = terminalReady
    ? `CASE WHEN r.failed THEN r.status_code
        WHEN ${terminalFailure} THEN f.status ELSE r.status_code END`
    : "r.status_code";
  const rawTimeRange = `r.timestamp >= $4::text::timestamptz - interval '1 microsecond'
    AND r.timestamp < $5::text::timestamptz + interval '1 microsecond'
    AND r.timestamp_exact >= $4 AND r.timestamp_exact < $5`;
  const finishedTimeRange = `f.finished_at >= $4::text::timestamptz
    AND f.finished_at < $5::text::timestamptz`;
  const candidateFinished = terminalReady
    ? `OR EXISTS (
        SELECT 1 FROM basalt_model_terminal_starts s
        JOIN basalt_model_terminal_finishes f ON f.request_id=s.request_id
        WHERE s.pool=r.pool AND s.request_id::text=r.request_id
          AND f.outcome <> 'unavailable' AND ${finishedTimeRange}
      )`
    : "";
  const homeTimeRange = terminalReady
    ? `((${finalAttempt} AND ${finishedTimeRange}) OR (NOT ${finalAttempt} AND ${rawTimeRange}))`
    : rawTimeRange;
  const latestHomeCtes = terminalReady
    ? `ranged_home_ids AS (
      SELECT DISTINCT r.request_id FROM basalt_model_requests r
      WHERE r.pool=$1 AND r.source=$3 AND r.request_id IS NOT NULL
        AND (${rawTimeRange} ${candidateFinished})
    ), latest_home AS (
      SELECT DISTINCT ON (r.pool,r.request_id) r.pool,r.request_id,r.id
      FROM basalt_model_requests r
      JOIN ranged_home_ids ids ON ids.request_id=r.request_id
      WHERE r.pool=$1 AND r.source=$3
      ORDER BY r.pool,r.request_id,r.timestamp_exact DESC,r.id DESC
    ),`
    : "";
  const result = await db.query(
    `WITH ranges(ordinal,from_at,to_at) AS (VALUES ${ranges
      .map((_, index) => `(${index},$${6 + index * 2}::text,$${7 + index * 2}::text)`)
      .join(",")}),
    ${latestHomeCtes} selected AS ${ranges.length > 1 ? "MATERIALIZED " : ""}(
      SELECT r.pool,r.source,r.client_key,
        (r.failed OR ${terminalFailure}) AS failed,
        ${statusCode} AS status_code,
        ((r.failed OR ${terminalFailure})
          AND r.account IS NULL) AS unassigned,
        ${terminalReady ? `CASE WHEN ${finalAttempt} THEN NULL ELSE r.timestamp_exact END` : "r.timestamp_exact"} AS raw_at,
        ${terminalReady ? `CASE WHEN ${finalAttempt} THEN f.finished_at ELSE NULL END` : "NULL::timestamptz"} AS finished_at
      FROM basalt_model_requests r
      ${terminalReady ? "LEFT JOIN latest_home last ON last.pool=r.pool AND last.request_id=r.request_id AND last.id=r.id" : ""}
      ${
        terminalReady
          ? `LEFT JOIN basalt_model_terminal_starts s
        ON s.pool=r.pool AND s.request_id::text=r.request_id
        LEFT JOIN basalt_model_terminal_finishes f ON f.request_id=s.request_id`
          : ""
      }
      WHERE r.pool=$1 AND r.source=$3
        AND ${homeTimeRange}
      UNION ALL
      SELECT r.pool,r.source,r.client_key,r.failed,r.status_code,
        (r.failed AND r.account IS NULL) AS unassigned,r.timestamp_exact AS raw_at,NULL::timestamptz AS finished_at
      FROM basalt_model_requests r
      WHERE r.pool=$1 AND r.source=ANY($2::character(64)[]) AND r.source<>$3
        AND ${rawTimeRange}
      ${
        terminalReady
          ? `UNION ALL
      SELECT s.pool,$3::character(64) AS source,s.client_key,
        (f.outcome IN ('truncated','client_closed','provider_failed')) AS failed,f.status AS status_code,
        (f.outcome IN ('truncated','client_closed','provider_failed')) AS unassigned,NULL::text AS raw_at,f.finished_at
      FROM basalt_model_terminal_starts s
      JOIN basalt_model_terminal_finishes f ON f.request_id=s.request_id
      WHERE s.pool=$1
        AND ${finishedTimeRange}
        AND f.outcome <> 'unavailable'
        AND NOT EXISTS (
          SELECT 1 FROM basalt_model_requests h
          WHERE h.pool=s.pool AND h.source=$3 AND h.request_id=s.request_id::text
        )`
          : ""
      }
    )
    SELECT ranges.ordinal,${isProof} AS proof, failed, status_code,
      count(*)::text AS requests,
      count(*) FILTER (WHERE failed AND unassigned)::text AS unassigned
    FROM selected r JOIN ranges ON
      (r.raw_at >= ranges.from_at AND r.raw_at < ranges.to_at)
      OR (r.finished_at >= ranges.from_at::timestamptz AND r.finished_at < ranges.to_at::timestamptz)
    GROUP BY ranges.ordinal,proof,failed,status_code ORDER BY ranges.ordinal,proof,status_code NULLS LAST`,
    [
      (await digest(pool)).slice(0, 16),
      sources,
      sources[0],
      start,
      end,
      ...ranges.flatMap(({ from, to }) => [from, to]),
    ],
  );
  const counts = (): ReliabilityCounts => ({
    requests: 0,
    failed: 0,
    unassignedFailures: 0,
    successRate: null,
    failures: [],
  });
  function sum(traffic: ReliabilityCounts, row: Record<string, unknown>): ReliabilityCounts {
    const count = requestCount(row.requests),
      unassigned = requestCount(row.unassigned);
    const requests = traffic.requests + count;
    const failed = traffic.failed + (row.failed === true ? count : 0);
    if (!Number.isSafeInteger(requests) || failed > requests || unassigned > count)
      throw new HistoryInputError();
    return {
      requests,
      failed,
      unassignedFailures: traffic.unassignedFailures + unassigned,
      successRate: requests ? ((requests - failed) * 100) / requests : null,
      failures:
        row.failed === true
          ? [
              ...traffic.failures,
              {
                status: row.status_code === null ? null : Number(row.status_code),
                count,
                unassigned,
              },
            ]
          : traffic.failures,
    };
  }
  const classification = ready ? ("ready" as const) : ("pending" as const);
  const output = ranges.map(({ from, to }) => ({
    from,
    to,
    classification,
    real: counts(),
    proof: counts(),
  }));
  for (const row of result.rows) {
    const ordinal = Number(row.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= output.length)
      throw new HistoryInputError();
    const current = output[ordinal];
    if (current === undefined) throw new HistoryInputError();
    if (row.proof === true) current.proof = sum(current.proof, row);
    else current.real = sum(current.real, row);
  }
  return output;
}
