import type {
  PoolReliability,
  ReliabilityCounts,
} from "../../../apps/pool/reliability-contract.ts";
import { digest } from "../backend-users.ts";
import type { HistoryDatabase } from "./schema.ts";
import { HistoryInputError, timestamp } from "./record.ts";
import { requestCount } from "./series-coverage.ts";

export async function readPoolReliability(
  db: HistoryDatabase,
  pool: string,
  from: string,
  to: string,
): Promise<PoolReliability> {
  const start = timestamp(from),
    end = timestamp(to);
  if (start >= end || Date.parse(end) - Date.parse(start) > 90 * 86_400_000 + 3_600_000)
    throw new HistoryInputError();
  const sources = await Promise.all([digest("home-local-v1"), digest("pool-gateway-v1")]);
  const ready =
    (await db.query("SELECT to_regclass('basalt_model_traffic') IS NOT NULL AS ready")).rows[0]
      ?.ready === true;
  const isProof = ready
    ? `EXISTS (SELECT 1 FROM basalt_model_traffic t
    WHERE t.pool=r.pool AND t.source=r.source AND t.client_key=r.client_key AND t.purpose='proof')`
    : "false";
  const result = await db.query(
    `SELECT ${isProof} AS proof, failed, status_code,
      count(*)::text AS requests,
      count(*) FILTER (WHERE failed AND account IS NULL)::text AS unassigned
    FROM basalt_model_requests r
    WHERE pool=$1 AND source=ANY($2::character(64)[])
      AND timestamp >= $3::text::timestamptz - interval '1 microsecond'
      AND timestamp < $4::text::timestamptz + interval '1 microsecond'
      AND timestamp_exact >= $3 AND timestamp_exact < $4
    GROUP BY proof,failed,status_code ORDER BY proof,status_code NULLS LAST`,
    [(await digest(pool)).slice(0, 16), sources, start, end],
  );
  const counts = (): ReliabilityCounts => ({
    requests: 0,
    failed: 0,
    unassignedFailures: 0,
    successRate: null,
    failures: [],
  });
  const real = counts(),
    proof = counts();
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
  let realCounts = real,
    proofCounts = proof;
  for (const row of result.rows) {
    if (row.proof === true) proofCounts = sum(proofCounts, row);
    else realCounts = sum(realCounts, row);
  }
  return {
    from: start,
    to: end,
    classification: ready ? "ready" : "pending",
    real: realCounts,
    proof: proofCounts,
  };
}
