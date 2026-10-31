import { digest } from "../backend-users.ts";
import { endpointMetadata, reference, timestamp, type ModelRequest } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import { insertRequests } from "./store.ts";

export interface GatewayRefusal {
  requestId: string;
  at: string;
  pool: string;
  person: string | null;
  keyId?: number;
  pathname: string;
  latencyMs: number;
}

/** A gateway refusal is an uncharged attempt with unknown token counts, distinct from Home attempts. */
export async function recordGatewayRefusal(db: HistoryDatabase, input: GatewayRefusal): Promise<void> {
  // Preserve the operator's existing activation boundary. Never create history on a model request.
  const active = await db.query("SELECT 1 FROM basalt_model_history_cursor LIMIT 1");
  if (!active.rows.length) return;
  const source = await digest("pool-gateway-v1");
  const sourceRecord = await digest(input.requestId);
  const row: ModelRequest = {
    id: await digest(JSON.stringify([source, sourceRecord])), source, sourceRecord,
    timestamp: timestamp(input.at), pool: (await digest(input.pool)).slice(0, 16), person: input.person,
    account: null, clientKey: await reference(source, "key", input.keyId), requestId: input.requestId,
    provider: null, model: null, ...endpointMetadata(input.pathname), apiType: "pool-protection-unavailable",
    serviceTier: null, inputTokens: null, outputTokens: null, cacheReadTokens: null,
    cacheWriteTokens: null, reasoningTokens: null, totalTokens: null, tokenQuality: "unclassified",
    latencyMs: String(Math.max(0, Math.round(input.latencyMs))), failed: true, statusCode: 503,
    cost: null, currency: null, costBasis: "unpriced", priceVersion: null,
    originalPriceRule: null, price: null, attribution: input.person === null ? "unknown" : "key-at-capture",
  };
  await insertRequests(db, [row]);
}
