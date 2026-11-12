import snapshot from "./public-price-baseline.json" with { type: "json" };
import type { OverviewApiPrice } from "../../apps/pool/overview-contract.ts";
import { priceAliases, type PriceTarget } from "./price-aliases.ts";

type Bands = readonly (readonly string[])[] | null;
const bare = (value: string) => value.slice(value.lastIndexOf("/") + 1).toLowerCase();
const byModel = new Map<string, { provider: string; bands: Bands }[]>();
for (const [provider, models] of Object.entries(snapshot.models))
  for (const [model, bands] of Object.entries(models)) {
    const key = bare(model);
    byModel.set(key, [...(byModel.get(key) ?? []), { provider, bands }]);
  }

/** The shipped snapshot is a floor, never a replacement for a saved successful refresh. */
export function baselinePrices(target: PriceTarget): {
  prices: readonly OverviewApiPrice[];
  reason: string;
} {
  const exact = bare(target.model);
  const candidates = [exact, ...(priceAliases([target])[0]?.source_models ?? []).map(bare)];
  const vendor = /^claude/.test(exact)
    ? "anthropic"
    : /^(gemini|gemma)/.test(exact)
      ? "google"
      : /^grok/.test(exact)
        ? "xai"
        : /^(gpt|o1|o3|o4|codex)/.test(exact)
          ? "openai"
          : target.provider.toLowerCase();
  const providers = [
    ...new Set([vendor, target.provider.toLowerCase(), "anthropic", "google", "xai", "openai"]),
  ];
  let selected: { provider: string; bands: Bands }[] = [];
  for (const candidate of candidates) {
    const matches = byModel.get(candidate) ?? [];
    const preferred = providers
      .map((provider) => matches.filter((match) => match.provider === provider))
      .find((matches) => matches.length > 0);
    if (preferred) {
      selected = preferred;
      break;
    }
  }
  // Like Home, prefer a direct vendor spelling/date alias before an unrelated routed offer.
  if (!selected.length)
    for (const candidate of candidates) {
      selected = byModel.get(candidate) ?? [];
      if (selected.length) break;
    }
  if (selected.length) {
    if (selected.length !== 1)
      return {
        prices: [],
        reason: `Public price for ${target.model} is ambiguous across catalog models.`,
      };
    const bands = selected[0]!.bands;
    if (!bands)
      return {
        prices: [],
        reason: `Public price for ${target.model} has incomplete or unsupported billing dimensions.`,
      };
    if (!bands.length) return { prices: [], reason: `No public price for ${target.model}` };
    return {
      prices: bands.map((band) => ({
        ...target,
        currency: "USD",
        minInput: band[0]!,
        input: band[1]!,
        output: band[2]!,
        cacheRead: band[3]!,
        cacheWrite: band[4]!,
        request: band[5]!,
        tier: "*",
        asOf: snapshot.asOf,
        source: "models.dev",
        version: snapshot.version,
        basis: "baseline",
      })),
      reason: "",
    };
  }
  return { prices: [], reason: `No public price for ${target.model}` };
}
