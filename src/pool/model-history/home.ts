import { digest, parseBackendUserName } from "../backend-users.ts";
import { amount, counter, endpointMetadata, historyObject, homePrice, identifier, invalidHistory, reference,
  timestamp, type ModelRequest } from "./record.ts";

export const homeHistorySource = "home-local-v1";

// Only metadata columns cross the SQL boundary. Do not select payload, failure text, auth_json,
// raw api_key, labels, request summaries or a complete price_snapshot.
export const homeHistorySelect = `SELECT u.id::text AS source_id,
  to_char(u.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp,
  u.request_id, u.auth_index, u.provider, u.model, u.endpoint, u.event_type, u.service_tier,
  u.input_tokens::text, u.output_tokens::text, u.reasoning_tokens::text,
  u.cached_tokens::text, u.cache_read_tokens::text, u.cache_read_tokens_present, u.cache_creation_tokens::text,
  u.total_tokens::text, u.token_accounting_quality, u.token_accounting_version,
  u.accounting_input_tokens::text, u.accounting_output_tokens::text,
  u.accounting_cache_read_tokens::text, u.accounting_cache_write_tokens::text, u.accounting_reasoning_tokens::text,
  u.accounting_total_tokens::text, u.latency_ms::text, u.failed, u.fail_status_code,
  u.upstream_status_code, c.id AS charge_id, c.amount::text AS amount,
  c.matched_price_rule,
  jsonb_build_object(
    'input_price_per_million', c.price_snapshot->'input_price_per_million',
    'output_price_per_million', c.price_snapshot->'output_price_per_million',
    'cache_read_price_per_million', c.price_snapshot->'cache_read_price_per_million',
    'cache_write_price_per_million', c.price_snapshot->'cache_write_price_per_million',
    'request_price', c.price_snapshot->'request_price',
    'matched_service_tier', c.price_snapshot->'matched_service_tier',
    'min_input_tokens', c.price_snapshot->'min_input_tokens') AS price,
  COALESCE(c.api_key_id, k.id)::text AS key_id,
  a.username
  FROM usage u
  LEFT JOIN billing_charge c ON c.usage_id = u.id
  LEFT JOIN api_key k ON k.diagnostic_fingerprint = u.api_key AND u.api_key ~ '^sha256:[0-9a-f]{64}$'
  LEFT JOIN "user" a ON a.id = COALESCE(c.user_id,k.user_id)`;

export async function homeRequest(raw: unknown, source: string): Promise<ModelRequest> {
  const row = historyObject(raw);
  const sourceId = counter(row.source_id);
  if (!sourceId || sourceId === "0" || typeof row.failed !== "boolean") return invalidHistory();
  const at = timestamp(row.timestamp);
  const requestId = identifier(row.request_id);
  // Node gives each upstream attempt a UUID, including retries and additional model records.
  // Home's auto-increment id is a fallback only for older rows without one.
  const sourceRecord = await digest(JSON.stringify(requestId ? ["request", requestId] : ["usage", sourceId]));
  const user = parseBackendUserName(row.username);
  const canonical = row.token_accounting_version === 2 && row.token_accounting_quality === "complete";
  const quality = canonical ? "complete" : row.token_accounting_quality === "inconsistent" ? "inconsistent"
    : row.token_accounting_quality === "unclassified" ? "unclassified" : "legacy";
  const priced = row.charge_id !== null && row.charge_id !== undefined && row.matched_price_rule !== "default:zero";
  const cost = priced ? amount(row.amount) : null;
  const price = cost === null ? null : homePrice(historyObject(row.price));
  const failureStatus = counter(row.fail_status_code);
  const status = row.failed && failureStatus !== null && failureStatus !== "0" ? failureStatus : counter(row.upstream_status_code);
  const code = status === null || status === "0" ? null : Number(status);
  if (code !== null && (code < 100 || code > 599)) return invalidHistory();
  return {
    id: await digest(JSON.stringify([source, sourceRecord])), source, sourceRecord, timestamp: at,
    pool: user?.pool ?? null, person: user?.person ?? null,
    account: await reference(source, "account", row.auth_index), clientKey: await reference(source, "key", row.key_id),
    requestId, provider: identifier(row.provider), model: identifier(row.model, true)!,
    ...endpointMetadata(row.endpoint), serviceTier: identifier(row.service_tier),
    inputTokens: counter(canonical ? row.accounting_input_tokens : row.input_tokens),
    outputTokens: counter(canonical ? row.accounting_output_tokens : row.output_tokens),
    cacheReadTokens: counter(canonical ? row.accounting_cache_read_tokens
      : row.cache_read_tokens_present === true ? row.cache_read_tokens : row.cached_tokens),
    cacheWriteTokens: counter(canonical ? row.accounting_cache_write_tokens : row.cache_creation_tokens),
    reasoningTokens: counter(canonical ? row.accounting_reasoning_tokens : row.reasoning_tokens),
    totalTokens: counter(canonical ? row.accounting_total_tokens : row.total_tokens),
    tokenQuality: quality, latencyMs: counter(row.latency_ms), failed: row.failed, statusCode: code,
    cost, currency: cost === null ? null : "credits", costBasis: cost === null ? "unpriced" : "home-charge",
    priceVersion: price === null ? null : await digest(JSON.stringify(price)), price,
    attribution: user ? row.charge_id ? "charge-snapshot" : "key-at-capture" : "unknown",
  };
}
