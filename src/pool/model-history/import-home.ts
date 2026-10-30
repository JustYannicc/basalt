import { digest } from "../backend-users.ts";
import { amount, counter, endpointMetadata, historyObject, identifier, invalidHistory, reference, timestamp, type ModelRequest } from "./record.ts";

export interface ImportContext { source: string; pool: string; person: string }

/** Pinned Home /usage/export JSONL has flattened metadata, unlike /usage/records. */
export async function importedHomeRequest(raw: unknown, context: ImportContext): Promise<ModelRequest> {
  const row = historyObject(raw), { source, pool, person } = context;
  if (typeof row.failed !== "boolean") return invalidHistory();
  const requestId = identifier(row.request_id), usageId = counter(row.usage_id);
  if (!requestId && usageId === null) return invalidHistory();
  const sourceRecord = await digest(JSON.stringify(requestId ? ["request", requestId] : ["usage", usageId]));
  const at = timestamp(row.timestamp);
  const canonical = row.token_breakdown_schema_version === 2 && row.token_breakdown_quality === "complete";
  const priced = row.amount !== null && row.amount !== undefined && row.matched_price_rule !== "default:zero";
  const cost = priced ? amount(row.amount) : null;
  // The export has a rule identity but no original rate snapshot. Preserve that limitation.
  const priceVersion = cost === null ? null : await digest(JSON.stringify([source, identifier(row.matched_price_rule), at]));
  const code = counter(row.status_code);
  const statusCode = code === null || code === "0" ? null : Number(code);
  if (statusCode !== null && (statusCode < 100 || statusCode > 599)) return invalidHistory();
  return {
    id: await digest(JSON.stringify([source, sourceRecord])), source, sourceRecord, timestamp: at, pool, person,
    account: await reference(source, "account", row.credential_id ?? row.auth_index),
    clientKey: await reference(source, "key", row.api_key_id), requestId,
    provider: identifier(row.provider), model: identifier(row.model, true)!,
    ...endpointMetadata(row.endpoint), serviceTier: identifier(row.service_tier),
    inputTokens: counter(canonical ? row.token_breakdown_input_total_tokens : row.input_tokens),
    outputTokens: counter(canonical ? row.token_breakdown_output_total_tokens : row.output_tokens),
    cacheReadTokens: counter(canonical ? row.token_breakdown_input_cache_read_tokens : row.cache_read_tokens ?? row.cached_tokens),
    cacheWriteTokens: counter(canonical ? row.token_breakdown_input_cache_write_tokens : row.cache_creation_tokens),
    reasoningTokens: counter(canonical ? row.token_breakdown_output_reasoning_tokens : row.reasoning_tokens),
    totalTokens: counter(canonical ? row.token_breakdown_total_tokens : row.total_tokens),
    tokenQuality: canonical ? "complete" : row.token_breakdown_quality === "inconsistent" ? "inconsistent"
      : row.token_breakdown_quality === "unclassified" ? "unclassified" : "legacy",
    latencyMs: counter(row.latency_ms), failed: row.failed, statusCode,
    cost, currency: cost === null ? null : identifier(row.currency, true), costBasis: cost === null ? "unpriced" : "home-charge",
    priceVersion, price: null, attribution: "import-owner",
  };
}
