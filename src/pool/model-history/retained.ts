import { amount, counter, historyObject, identifier, invalidHistory, timestamp, type ModelRequest } from "./record.ts";

// Ledger values are decoded explicitly so replay uses the immutable row, including attribution.
export const retainedProjection = `id,source,source_record,timestamp_exact,pool,person,account,client_key,
  request_id,provider,model,endpoint,api_type,service_tier,input_tokens::text,output_tokens::text,
  cache_read_tokens::text,cache_write_tokens::text,reasoning_tokens::text,total_tokens::text,
  token_quality,latency_ms::text,failed,status_code,cost::text,currency,cost_basis,price_version,price_snapshot,attribution`;

export function retainedRequest(row: Record<string, unknown>): ModelRequest {
  const quality = row.token_quality, basis = row.cost_basis, attribution = row.attribution;
  if (quality !== "complete" && quality !== "legacy" && quality !== "unclassified" && quality !== "inconsistent") return invalidHistory();
  if (basis !== "home-charge" && basis !== "historical-api-price" && basis !== "unpriced") return invalidHistory();
  if (attribution !== "charge-snapshot" && attribution !== "key-at-capture" && attribution !== "import-owner" && attribution !== "unknown") return invalidHistory();
  if (typeof row.failed !== "boolean") return invalidHistory();
  const price = row.price_snapshot === null ? null : historyObject(row.price_snapshot);
  const rates = price ? [price.input, price.output, price.cacheRead, price.cacheWrite, price.request].map((rate) => {
    if (amount(rate) === null) return invalidHistory();
    return String(rate);
  }) : [];
  return {
    id: identifier(row.id, true)!, source: identifier(row.source, true)!, sourceRecord: identifier(row.source_record, true)!,
    timestamp: timestamp(row.timestamp_exact), pool: identifier(row.pool), person: identifier(row.person),
    account: identifier(row.account), clientKey: identifier(row.client_key), requestId: identifier(row.request_id),
    provider: identifier(row.provider), model: identifier(row.model), endpoint: row.endpoint === null ? null : String(row.endpoint),
    apiType: identifier(row.api_type),
    serviceTier: identifier(row.service_tier), inputTokens: counter(row.input_tokens), outputTokens: counter(row.output_tokens),
    cacheReadTokens: counter(row.cache_read_tokens), cacheWriteTokens: counter(row.cache_write_tokens),
    reasoningTokens: counter(row.reasoning_tokens), totalTokens: counter(row.total_tokens),
    tokenQuality: quality, latencyMs: counter(row.latency_ms), failed: row.failed,
    statusCode: row.status_code === null ? null : Number(row.status_code), cost: amount(row.cost),
    currency: identifier(row.currency), costBasis: basis, priceVersion: identifier(row.price_version), attribution,
    price: price ? { input: rates[0]!, output: rates[1]!, cacheRead: rates[2]!, cacheWrite: rates[3]!, request: rates[4]!,
      tier: price.tier === "*" ? "*" : identifier(price.tier), minInput: counter(price.minInput)!,
      validFrom: price.validFrom === null ? null : timestamp(price.validFrom),
      validTo: price.validTo === null ? null : timestamp(price.validTo) } : null,
  };
}
