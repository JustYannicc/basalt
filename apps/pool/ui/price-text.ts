import type { OverviewPriceProvenance } from "../overview-contract.ts";
import { combinePrice, provenance } from "./series-model.ts";

// How an estimate's public rates were obtained, in words. Live rates are the expected case and stay
// quiet in rows; baseline and failed-refresh rates always say which rates and how old they are.

export type Price = Required<OverviewPriceProvenance>;

const date = (iso: string, year = true) => {
  const value = new Date(iso);
  return Number.isNaN(value.getTime())
    ? "an unknown date"
    : value.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        ...(year ? { year: "numeric" } : {}),
        timeZone: "UTC",
      });
};

/** Oldest rate set among the slices, marked baseline or failed if any of them was. */
export function slicePrice(slices: readonly { readonly price: OverviewPriceProvenance | null }[]) {
  let price: Price | null = null;
  for (const slice of slices) if (slice.price) price = combinePrice(price, provenance(slice.price));
  return price;
}

export const samePrice = (a: Price | null, b: Price | null) =>
  a?.asOf === b?.asOf && a?.basis === b?.basis && a?.refreshFailed === b?.refreshFailed;

export const priceTitle = (price: Price) => `${price.source} ${price.version}, ${date(price.asOf)}`;

/** Row lines under an amount, or null for refreshed live rates. */
export function priceNoteLines(price: Price | null): { lines: string[]; failed: boolean } | null {
  if (!price || (price.basis === "live" && !price.refreshFailed)) return null;
  const day = date(price.asOf, false);
  if (!price.refreshFailed) return { lines: [`Price as of ${day}`], failed: false };
  // A first read that never refreshed still runs on the shipped baseline; say so, not "last good".
  if (price.basis === "baseline")
    return { lines: ["Refresh failed", `Baseline price as of ${day}`], failed: true };
  return { lines: [`Refresh failed · ${day}`], failed: true };
}

/** Whole-range provenance for a headline figure; the exact version goes in a tooltip. */
export function priceSentence(price: Price | null): {
  text: string;
  failed: boolean;
  detail?: string;
} {
  if (!price) return { text: "Price date unavailable.", failed: false };
  const detail = `${price.source} ${price.version}`;
  const day = date(price.asOf);
  if (price.refreshFailed && price.basis === "baseline")
    return {
      text: `Shipped baseline ${price.source} prices, as of ${day}. Price refresh failed.`,
      failed: true,
      detail,
    };
  if (price.refreshFailed)
    return {
      text: `Price refresh failed. Last good ${price.source} prices, as of ${day}.`,
      failed: true,
      detail,
    };
  if (price.basis === "baseline")
    return { text: `Baseline ${price.source} prices, as of ${day}.`, failed: false, detail };
  return { text: `Live ${price.source} prices, updated ${day}.`, failed: false, detail };
}
