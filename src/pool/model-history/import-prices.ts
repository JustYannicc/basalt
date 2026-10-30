import { digest } from "../backend-users.ts";
import { amount, counter, historyObject, identifier, invalidHistory, timestamp, type HistoryPrice, type ModelRequest } from "./record.ts";

interface ImportPrice extends HistoryPrice {
  provider: string;
  model: string;
  currency: "USD";
  version: string;
}

const scale = 1_000_000_000_000n;
const fixed = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(12, "0"));
};
const decimal = (value: bigint) => `${value / scale}.${(value % scale).toString().padStart(12, "0")}`;

/** Historical dates are required. Today's catalog is never applied retroactively by default. */
export async function importPrices(raw: unknown): Promise<ImportPrice[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 500) return invalidHistory();
  const prices: ImportPrice[] = [];
  for (const item of raw) {
    const value = historyObject(item);
    const validFrom = timestamp(value.validFrom), validTo = timestamp(value.validTo);
    if (validFrom >= validTo || value.currency !== "USD") return invalidHistory();
    const input = amount(value.input), output = amount(value.output), cacheRead = amount(value.cacheRead),
      cacheWrite = amount(value.cacheWrite), request = amount(value.request ?? 0);
    if ([input, output, cacheRead, cacheWrite, request].some((rate) => rate === null)) return invalidHistory();
    const price = {
      provider: identifier(value.provider, true)!, model: identifier(value.model, true)!, currency: "USD" as const,
      input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite!, request: request!,
      tier: value.tier === "*" ? "*" : identifier(value.tier), minInput: counter(value.minInput) ?? "0", validFrom, validTo,
    };
    prices.push({ ...price, version: await digest(JSON.stringify(price)) });
  }
  return prices;
}

export function priceImportedRequest(row: ModelRequest, prices: readonly ImportPrice[]): ModelRequest {
  if (row.cost !== null || row.failed || row.tokenQuality !== "complete" || !row.provider || row.inputTokens === null || row.outputTokens === null
    || row.cacheReadTokens === null || row.cacheWriteTokens === null || row.reasoningTokens === null
    || row.totalTokens === null) return row;
  if (BigInt(row.inputTokens) + BigInt(row.outputTokens) !== BigInt(row.totalTokens)
    || BigInt(row.reasoningTokens) > BigInt(row.outputTokens)
    || BigInt(row.cacheReadTokens) + BigInt(row.cacheWriteTokens) > BigInt(row.inputTokens)) return row;
  const candidates = prices.filter((price) => price.provider === row.provider && price.model === row.model
    && price.validFrom! <= row.timestamp && row.timestamp < price.validTo!
    && (price.tier === "*" || price.tier === row.serviceTier) && BigInt(price.minInput) <= BigInt(row.inputTokens!));
  candidates.sort((a, b) => Number(b.tier !== "*") - Number(a.tier !== "*")
    || (BigInt(a.minInput) < BigInt(b.minInput) ? 1 : BigInt(a.minInput) > BigInt(b.minInput) ? -1 : 0));
  const selected = candidates[0];
  if (!selected) return row;
  if (candidates[1] && candidates[1].tier === selected.tier && candidates[1].minInput === selected.minInput)
    return invalidHistory();
  const uncached = BigInt(row.inputTokens) - BigInt(row.cacheReadTokens) - BigInt(row.cacheWriteTokens);
  if (uncached < 0n) return row;
  // Rates have twelve fractional digits; round once to the ledger's twelve-digit money scale.
  const tokenCost = uncached * fixed(selected.input) + BigInt(row.outputTokens) * fixed(selected.output)
    + BigInt(row.cacheReadTokens) * fixed(selected.cacheRead) + BigInt(row.cacheWriteTokens) * fixed(selected.cacheWrite);
  const cost = decimal((tokenCost + 500_000n) / 1_000_000n + fixed(selected.request));
  const { provider: _, model: __, currency, version, ...price } = selected;
  return { ...row, cost, currency, costBasis: "historical-api-price", priceVersion: version, price };
}
