import { digest } from "../backend-users.ts";
import { counter, historyObject, identifier, invalidHistory, reference, timestamp, type ModelRequest } from "./record.ts";
import type { ImportContext } from "./import-home.ts";

export interface LegacySelection {
  offset: number;
  limit: number;
  providers: ReadonlyMap<string, string>;
}

export async function legacySnapshot(raw: unknown, context: ImportContext, selection: LegacySelection) {
  const exportValue = historyObject(raw);
  if (exportValue.version !== 1 && exportValue.version !== 0) return invalidHistory();
  const usage = historyObject(exportValue.usage), apis = historyObject(usage.apis ?? {});
  const declared = counter(usage.total_requests);
  const records: ModelRequest[] = [];
  const occurrences = new Map<string, number>();
  let details = 0, missingDetails = 0n, ambiguous = 0;
  for (const [key, rawApi] of Object.entries(apis)) {
    const api = historyObject(rawApi), models = historyObject(api.models ?? {});
    const clientKey = await reference(context.source, "key", key);
    for (const [modelName, rawModel] of Object.entries(models)) {
      const model = identifier(modelName, true)!, modelValue = historyObject(rawModel);
      const items = modelValue.details ?? [];
      if (!Array.isArray(items)) return invalidHistory();
      const expected = counter(modelValue.total_requests);
      if (expected !== null) missingDetails += BigInt(expected) > BigInt(items.length) ? BigInt(expected) - BigInt(items.length) : 0n;
      for (const rawDetail of items) {
        const row = historyObject(rawDetail), tokens = historyObject(row.tokens ?? {});
        if (typeof row.failed !== "boolean") return invalidHistory();
        const at = timestamp(row.timestamp), account = await reference(context.source, "account", row.auth_index);
        // Some v6 builds put a credential filename or provider URL in source. Retain only a hash
        // for deduplication, never that free-form value itself.
        const sourceRef = await reference(context.source, "legacy-source", row.source);
        const counts = [tokens.input_tokens, tokens.output_tokens, tokens.cached_tokens, tokens.reasoning_tokens, tokens.total_tokens].map(counter);
        const fingerprint = await digest(JSON.stringify([clientKey, model, at, account, sourceRef, row.failed, counts]));
        const occurrence = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, occurrence + 1);
        if (occurrence > 0) ambiguous++;
        const index = details++;
        if (index < selection.offset || index >= selection.offset + selection.limit) continue;
        // Identical details are distinct rows in the source. Their occurrence number preserves
        // that multiplicity across reordered exports and repeated page uploads.
        const sourceRecord = await digest(JSON.stringify(["legacy-detail", fingerprint, occurrence]));
        records.push({
          id: await digest(JSON.stringify([context.source, sourceRecord])), source: context.source, sourceRecord,
          timestamp: at, pool: context.pool, person: context.person, account, clientKey, requestId: null,
          provider: selection.providers.get(model) ?? null, model, endpoint: null, apiType: null, serviceTier: null,
          inputTokens: counts[0]!, outputTokens: counts[1]!, cacheReadTokens: counts[2]!, cacheWriteTokens: null,
          reasoningTokens: counts[3]!, totalTokens: counts[4]!, tokenQuality: "legacy", latencyMs: null,
          failed: row.failed, statusCode: null, cost: null, currency: null, costBasis: "unpriced",
          originalPriceRule: null, priceVersion: null, price: null, attribution: "import-owner",
        });
      }
    }
  }
  const unimportable = declared !== null && BigInt(declared) > BigInt(details) ? BigInt(declared) - BigInt(details) : missingDetails;
  return { records, total: details, aggregateOnly: unimportable.toString(), indistinguishableDetails: ambiguous };
}
