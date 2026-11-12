import snapshot from "./public-price-baseline.json" with { type: "json" };
import type { OverviewApiPrice } from "../../apps/pool/overview-contract.ts";
import { priceAliases, type PriceTarget } from "./price-aliases.ts";

const models: Readonly<
  Record<string, Readonly<Record<string, readonly (readonly string[])[] | null>>>
> = snapshot.models;
const bare = (value: string) => value.slice(value.lastIndexOf("/") + 1).toLowerCase();

/** The shipped snapshot is a floor, never a replacement for a saved successful refresh. */
export function baselinePrices(target: PriceTarget): {
  prices: readonly OverviewApiPrice[];
  reason: string;
} {
  const exact = bare(target.model);
  const candidates = [exact, ...(priceAliases([target])[0]?.source_models ?? []).map(bare)];
  const vendor = /^(claude)/.test(exact)
    ? "anthropic"
    : /^(gemini|gemma)/.test(exact)
      ? "google"
      : /^grok/.test(exact)
        ? "xai"
        : /^(gpt|o1|o3|o4|codex)/.test(exact)
          ? "openai"
          : target.provider.toLowerCase();
  // Match exact identities before spelling/date aliases, with Home's first-party preference.
  const providers = [
    ...new Set([vendor, target.provider.toLowerCase(), "anthropic", "google", "xai", "openai"]),
  ];
  for (const candidate of candidates) {
    for (const provider of providers) {
      const entries = models[provider];
      const key = entries && Object.keys(entries).find((key) => bare(key) === candidate);
      if (!key) continue;
      const bands = entries![key];
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
  }
  return { prices: [], reason: `No public price for ${target.model}` };
}
