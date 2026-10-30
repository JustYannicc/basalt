import { digest } from "../backend-users.ts";
import { homeHistorySource } from "./home.ts";
import { counter, historyObject, identifier, invalidHistory, type ModelRequest } from "./record.ts";
import { historyBatchSize } from "./store.ts";
import { importedHomeRequest, type ImportContext } from "./import-home.ts";
import { legacySnapshot } from "./import-legacy.ts";
import { importPrices, priceImportedRequest } from "./import-prices.ts";

export const maximumImportBytes = 8 * 1024 * 1024;
export interface ParsedImport {
  records: ModelRequest[];
  local: boolean;
  homeUsageIds: (string | null)[];
  digest: string;
  next: number | null;
  report: {
    format: "home-v8-jsonl" | "cpa-v6";
    totalDetails: number;
    pageDetails: number;
    aggregateOnlyNotImportable: string;
    indistinguishableDetails: number;
    unpriced: number;
    missingProvider: number;
    missingEndpoint: number;
    missingLatency: number;
    missingPriceSnapshot: number;
  };
}

/** Only the selected metadata leaves this function. The source export is never persisted. */
export async function parseUsageImport(raw: unknown, owner: { pool: string; person: string }): Promise<ParsedImport> {
  const input = historyObject(raw);
  if (input.format !== "home-v8-jsonl" && input.format !== "cpa-v6") return invalidHistory();
  if (typeof input.source !== "string" || input.source !== homeHistorySource && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.source)) return invalidHistory();
  if (typeof input.data !== "string" || new TextEncoder().encode(input.data).byteLength > maximumImportBytes) return invalidHistory();
  const offset = input.offset ?? 0;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return invalidHistory();
  const context: ImportContext = {
    source: input.source === homeHistorySource ? await digest(homeHistorySource)
      : await digest(JSON.stringify(["usage-import-v1", owner.pool, input.source])),
    pool: (await digest(owner.pool)).slice(0, 16), person: await digest(owner.person),
  };
  if (input.source === homeHistorySource && input.format !== "home-v8-jsonl") return invalidHistory();
  const providers = new Map<string, string>();
  if (input.models !== undefined) {
    if (!Array.isArray(input.models) || input.models.length > 500) return invalidHistory();
    for (const rawModel of input.models) {
      const item = historyObject(rawModel), model = identifier(item.model, true)!, provider = identifier(item.provider, true)!;
      if (providers.has(model)) return invalidHistory();
      providers.set(model, provider);
    }
  }
  let homeUsageIds: (string | null)[] = [];
  let selected: { records: ModelRequest[]; total: number; aggregateOnly: string; indistinguishableDetails: number };
  if (input.format === "cpa-v6") {
    selected = await legacySnapshot(JSON.parse(input.data), context, { offset, limit: historyBatchSize, providers });
  } else {
    const lines = input.data.split(/\r?\n/).filter((line) => line.trim());
    const page = lines.slice(offset, offset + historyBatchSize).map((line) => historyObject(JSON.parse(line)));
    homeUsageIds = page.map((row) => counter(row.usage_id));
    selected = { records: await Promise.all(page.map((row) => importedHomeRequest(row, context))), total: lines.length, aggregateOnly: "0", indistinguishableDetails: 0 };
  }
  if (offset > selected.total) return invalidHistory();
  const prices = await importPrices(input.prices);
  const records = selected.records.map((row) => priceImportedRequest(row, prices));
  const report = {
    format: input.format, totalDetails: selected.total, pageDetails: records.length,
    aggregateOnlyNotImportable: selected.aggregateOnly, indistinguishableDetails: selected.indistinguishableDetails,
    unpriced: records.filter((row) => row.cost === null).length,
    missingProvider: records.filter((row) => row.provider === null).length,
    missingEndpoint: records.filter((row) => row.endpoint === null).length,
    missingLatency: records.filter((row) => row.latencyMs === null).length,
    missingPriceSnapshot: records.filter((row) => row.price === null).length,
  };
  return {
    records, report, local: input.source === homeHistorySource, homeUsageIds,
    digest: await digest(JSON.stringify({ records, report, source: context.source, offset })),
    next: offset + records.length < selected.total ? offset + records.length : null,
  };
}
