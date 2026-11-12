import { appAttributionReady } from "./schema.ts";
import type { HistoryDatabase } from "./schema.ts";
import type { ModelRequest } from "./record.ts";

export const historyBatchSize = 200;
export class HistoryConflict extends Error {
  constructor() {
    super("Model usage identity conflicts with retained history");
  }
}

// This projection is also the JSON sent to Postgres. Extra properties from an import never leave
// the parser's process, even if a caller passes an object with additional runtime properties.
export function recordValues(row: ModelRequest, appAttribution = true) {
  return {
    id: row.id,
    source: row.source,
    source_record: row.sourceRecord,
    timestamp: row.timestamp,
    timestamp_exact: row.timestamp,
    pool: row.pool,
    person: row.person,
    account: row.account,
    client_key: row.clientKey,
    ...(appAttribution ? { app_id: row.appId ?? null, requirement: row.requirement ?? null } : {}),
    request_id: row.requestId,
    provider: row.provider,
    model: row.model,
    endpoint: row.endpoint,
    api_type: row.apiType,
    service_tier: row.serviceTier,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    reasoning_tokens: row.reasoningTokens,
    total_tokens: row.totalTokens,
    token_quality: row.tokenQuality,
    latency_ms: row.latencyMs,
    failed: row.failed,
    status_code: row.statusCode,
    cost: row.cost,
    currency: row.currency,
    cost_basis: row.costBasis,
    price_version: row.priceVersion,
    original_price_rule: row.originalPriceRule,
    price_snapshot:
      row.price === null
        ? null
        : {
            input: row.price.input,
            output: row.price.output,
            cacheRead: row.price.cacheRead,
            cacheWrite: row.price.cacheWrite,
            request: row.price.request,
            tier: row.price.tier,
            minInput: row.price.minInput,
            validFrom: row.price.validFrom,
            validTo: row.price.validTo,
            billing:
              row.price.billing === null
                ? null
                : {
                    matchedRule: row.price.billing.matchedRule,
                    provider: row.price.billing.provider,
                    model: row.price.billing.model,
                    requestedTier: row.price.billing.requestedTier,
                    responseTier: row.price.billing.responseTier,
                    tierSource: row.price.billing.tierSource,
                    effectiveTier: row.price.billing.effectiveTier,
                    responseFallback: row.price.billing.responseFallback,
                  },
          },
    attribution: row.attribution,
  };
}

const columns = `id, source, source_record, timestamp, timestamp_exact, pool, person, account, client_key,
  request_id, provider, model, endpoint, api_type, service_tier, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, token_quality, latency_ms,
  failed, status_code, cost, currency, cost_basis, price_version, original_price_rule, price_snapshot, attribution`;
const typedColumns = `id char(64), source char(64), source_record char(64), timestamp timestamptz,
  timestamp_exact varchar(30), pool varchar(16), person char(64), account char(64), client_key char(64),
  request_id varchar(256), provider varchar(256), model varchar(256), endpoint varchar(256), api_type varchar(64),
  service_tier varchar(256), input_tokens bigint, output_tokens bigint, cache_read_tokens bigint,
  cache_write_tokens bigint, reasoning_tokens bigint, total_tokens bigint, token_quality varchar(16),
  latency_ms bigint, failed boolean, status_code smallint, cost numeric(28,12), currency varchar(16),
  cost_basis varchar(32), price_version char(64), original_price_rule varchar(1024), price_snapshot jsonb, attribution varchar(32)`;

export async function existingRequests(
  db: HistoryDatabase,
  records: readonly ModelRequest[],
  preserveOriginalAttribution = false,
  strictContent = false,
): Promise<Set<string>> {
  if (records.length > historyBatchSize) throw new Error("Model usage batch exceeds its limit");
  if (!records.length) return new Set();
  if (strictContent) {
    const incoming = new Map<string, string>();
    for (const row of records) {
      const value = JSON.stringify(recordValues(row));
      if (incoming.has(row.id) && incoming.get(row.id) !== value) throw new HistoryConflict();
      incoming.set(row.id, value);
    }
    const appAttribution = await appAttributionReady(db);
    if (!appAttribution && records.some((row) => row.appId != null || row.requirement != null))
      throw new HistoryConflict();
    const selected = columns + (appAttribution ? ", app_id, requirement" : "");
    const types =
      typedColumns + (appAttribution ? ", app_id varchar(256), requirement varchar(64)" : "");
    const names = selected.split(",").map((name) => name.trim());
    const conflicts = await db.query(
      `SELECT incoming.id FROM jsonb_to_recordset($1::jsonb) AS incoming(${types})
      CROSS JOIN LATERAL (SELECT ${selected} FROM basalt_model_requests
        WHERE id=incoming.id LIMIT 1) AS saved
      WHERE ROW(${names.map((name) => `saved.${name}`).join(",")})
        IS DISTINCT FROM ROW(${names.map((name) => `incoming.${name}`).join(",")}) LIMIT 1`,
      [JSON.stringify(records.map((row) => recordValues(row, appAttribution)))],
    );
    if (conflicts.rows.length) throw new HistoryConflict();
  }
  // Per-ID lateral lookups prune hash partitions and cannot turn a small import into a table scan.
  const result = await db.query(
    `SELECT saved.id,saved.source,saved.source_record,saved.pool
    FROM unnest($1::char(64)[]) AS incoming(id)
    CROSS JOIN LATERAL (SELECT id,source,source_record,pool FROM basalt_model_requests
      WHERE id=incoming.id LIMIT 1) AS saved`,
    [records.map((row) => row.id)],
  );
  const byId = new Map(records.map((row) => [row.id, row]));
  for (const saved of result.rows) {
    const row = byId.get(String(saved.id))!;
    // A manager of one pool cannot claim another pool's retained record by reusing its request ID.
    if (
      saved.source !== row.source ||
      saved.source_record !== row.sourceRecord ||
      (!preserveOriginalAttribution && saved.pool !== row.pool)
    )
      throw new HistoryConflict();
  }
  return new Set(result.rows.map((row) => String(row.id)));
}

/** The caller owns the transaction, including its source cursor or import receipt. */
export async function insertRequests(
  db: HistoryDatabase,
  records: readonly ModelRequest[],
  preserveOriginalAttribution = false,
  strictContent = false,
): Promise<number> {
  const existing = await existingRequests(db, records, preserveOriginalAttribution, strictContent);
  const missing = records.filter((row) => !existing.has(row.id));
  if (!records.length) return 0;
  const appAttribution = await appAttributionReady(db);
  if (!appAttribution && records.some((row) => row.appId != null || row.requirement != null))
    throw new Error("App model attribution migration is not ready");
  if (!missing.length) return 0;
  const selected = columns + (appAttribution ? ", app_id, requirement" : "");
  const types =
    typedColumns + (appAttribution ? ", app_id varchar(256), requirement varchar(64)" : "");
  const result = await db.query(
    `INSERT INTO basalt_model_requests (${selected})
    SELECT ${selected} FROM jsonb_to_recordset($1::jsonb) AS incoming(${types})
    ON CONFLICT (id) DO NOTHING RETURNING id`,
    [JSON.stringify(missing.map((row) => recordValues(row, appAttribution)))],
  );
  // Repeat the ownership check after ON CONFLICT waits for a concurrent import to commit.
  await existingRequests(db, records, preserveOriginalAttribution, strictContent);
  return result.rowCount ?? result.rows.length;
}

export interface HistoryQuery {
  pool: string;
  person?: string;
  from: string;
  to: string;
  after?: { timestamp: string; id: string };
}

/** Keyset pagination stays bounded even when a pool has years of retained history. */
export async function readRequests(db: HistoryDatabase, query: HistoryQuery) {
  const attribution = (await appAttributionReady(db))
    ? "app_id, requirement"
    : "NULL::text AS app_id, NULL::text AS requirement";
  const result = await db.query(
    `SELECT id, source, timestamp_exact AS timestamp,
    person, account, client_key, request_id, ${attribution}, provider, model, endpoint, api_type, service_tier,
    input_tokens::text, output_tokens::text, cache_read_tokens::text, cache_write_tokens::text,
    reasoning_tokens::text, total_tokens::text, token_quality, latency_ms::text, failed, status_code,
    cost::text, currency, cost_basis, price_version, original_price_rule, price_snapshot, attribution,
    to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_timestamp
    FROM basalt_model_requests
    WHERE pool = $1 AND ($2::text IS NULL OR person = $2) AND timestamp >= $3 AND timestamp < $4
      AND ($5::timestamptz IS NULL OR (timestamp,id) > ($5::timestamptz,$6::text))
    ORDER BY timestamp,id LIMIT 201`,
    [
      query.pool,
      query.person ?? null,
      query.from,
      query.to,
      query.after?.timestamp ?? null,
      query.after?.id ?? null,
    ],
  );
  const rows = result.rows.slice(0, historyBatchSize);
  const last = rows.at(-1);
  return {
    records: rows.map((record) => {
      const row = { ...record };
      delete row.page_timestamp;
      return row;
    }),
    next:
      result.rows.length > historyBatchSize && last
        ? { timestamp: String(last.page_timestamp), id: String(last.id) }
        : null,
  };
}
