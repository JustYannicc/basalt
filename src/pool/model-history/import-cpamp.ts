import { digest } from "../backend-users.ts";
import type { ImportContext } from "./import-home.ts";
import {
  counter,
  endpointMetadata,
  historyObject,
  identifier,
  invalidHistory,
  reference,
  timestamp,
  type ModelRequest,
} from "./record.ts";

/** Manager Plus metadata export v1. Exporters select these fields, never raw source JSON. */
export async function importedManagerRequest(
  raw: unknown,
  context: ImportContext,
): Promise<ModelRequest> {
  const row = historyObject(raw),
    { source, pool, person } = context;
  if (
    typeof row.event_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.event_hash) ||
    typeof row.failed !== "boolean"
  )
    return invalidHistory();
  const sourceRecord = await digest(JSON.stringify(["cpamp-event-v1", row.event_hash]));
  const status = counter(row.status_code);
  const statusCode = status === null || status === "0" ? null : Number(status);
  if (statusCode !== null && (statusCode < 100 || statusCode > 599)) return invalidHistory();
  return {
    id: await digest(JSON.stringify([source, sourceRecord])),
    source,
    sourceRecord,
    timestamp: timestamp(row.timestamp),
    pool,
    person,
    account: await reference(source, "account", row.account_ref),
    clientKey: await reference(source, "key", row.client_key_ref),
    requestId: identifier(row.request_id),
    provider: identifier(row.provider),
    model: identifier(row.model),
    ...endpointMetadata(row.endpoint),
    serviceTier: identifier(row.service_tier),
    inputTokens: counter(row.input_tokens),
    outputTokens: counter(row.output_tokens),
    cacheReadTokens: counter(row.cache_read_tokens),
    cacheWriteTokens: counter(row.cache_write_tokens),
    reasoningTokens: counter(row.reasoning_tokens),
    totalTokens: counter(row.total_tokens),
    // The source has no canonical token-breakdown proof or authoritative billed amount.
    tokenQuality: "legacy",
    latencyMs: counter(row.latency_ms),
    failed: row.failed,
    statusCode,
    cost: null,
    currency: null,
    costBasis: "unpriced",
    priceVersion: null,
    originalPriceRule: null,
    price: null,
    attribution: "import-owner",
  };
}
