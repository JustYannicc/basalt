import type { OverviewApiPrice, OverviewPriceIssue } from "../../apps/pool/overview-contract.ts";
import { object, rows, text, type Json } from "./json.ts";
import type { PriceTarget } from "./price-aliases.ts";

function priceNumber(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1e9)
    return null;
  const decimal = value.toFixed(12).replace(/\.?0+$/, "");
  return value > 0 && Number(decimal) === 0 ? null : decimal || "0";
}

/** A malformed or unsupported context band excludes the entire model, including its cheap base. */
export function overviewPricePreview(
  preview: Json,
  targets: readonly PriceTarget[],
  completedAt: number,
) {
  const version = text(preview.source_version),
    asOf = text(preview.source_fetched_at);
  if (
    preview.source !== "models.dev" ||
    preview.atomic !== true ||
    !version ||
    !asOf ||
    !Number.isFinite(Date.parse(asOf)) ||
    Date.parse(asOf) > completedAt + 60_000 ||
    completedAt - Date.parse(asOf) > 86_400_000
  )
    throw new Error("Invalid public price snapshot");
  const result = new Map<string, readonly OverviewApiPrice[]>();
  const issues: OverviewPriceIssue[] = [];
  const all = rows(preview.rows);
  for (const target of targets) {
    const own = all.filter((row) => row.provider === target.provider && row.model === target.model);
    const bands: OverviewApiPrice[] = [];
    const seen = new Set<number>();
    for (const row of own) {
      if (
        !["matched", "zero_cost"].includes(text(row.status) ?? "") ||
        !object(row.official) ||
        row.service_tier !== "*" ||
        typeof row.min_input_tokens !== "number" ||
        !Number.isSafeInteger(row.min_input_tokens) ||
        row.min_input_tokens < 0 ||
        seen.has(row.min_input_tokens)
      )
        break;
      const official = row.official;
      const input = priceNumber(official.input),
        output = priceNumber(official.output),
        cacheRead = priceNumber(official.cache_read),
        cacheWrite = priceNumber(official.cache_write),
        request = priceNumber(official.request);
      if ([input, output, cacheRead, cacheWrite, request].includes(null)) break;
      seen.add(row.min_input_tokens);
      bands.push({
        ...target,
        currency: "USD",
        input: input!,
        output: output!,
        cacheRead: cacheRead!,
        cacheWrite: cacheWrite!,
        request: request!,
        tier: "*",
        minInput: String(row.min_input_tokens),
        asOf,
        source: "models.dev",
        version,
      });
    }
    if (bands.length && bands.length === own.length && seen.has(0))
      result.set(JSON.stringify([target.provider, target.model]), bands);
    else
      issues.push({
        ...target,
        reason: own.some((row) => row.status === "unmatched")
          ? `No public price for ${target.model}`
          : `Public price for ${target.model} has incomplete or unsupported billing dimensions.`,
      });
  }
  return { prices: result, issues };
}
