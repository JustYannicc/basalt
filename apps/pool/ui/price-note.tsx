import type { OverviewPriceProvenance } from "../overview-contract.ts";
import { StateIcon } from "./controls.tsx";
import { combinePrice, provenance } from "./series-model.ts";

// How an estimate's public rates were obtained. Live rates are the expected case and stay quiet in
// rows; baseline and failed-refresh rates always say how old they are, next to the amount.

type Price = Required<OverviewPriceProvenance>;

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

/** The short line a row shows under its amount, or nothing for refreshed live rates. */
export function PriceNote({ price, start = false }: { price: Price | null; start?: boolean }) {
  if (!price || (price.basis === "live" && !price.refreshFailed)) return null;
  return (
    <span
      title={`${price.source} ${price.version}, ${date(price.asOf)}`}
      className={`mt-0.5 block text-xs leading-snug font-normal whitespace-nowrap ${start ? "text-left" : "text-right"} ${price.refreshFailed ? "text-warning" : "text-muted-foreground"}`}
    >
      {price.refreshFailed && (
        <StateIcon tone="warn" className="mr-1 inline-block size-3 align-[-1px]" />
      )}
      {price.refreshFailed ? "Refresh failed · " : "Price as of "}
      {date(price.asOf, false)}
    </span>
  );
}

/** Whole-range provenance for a headline figure; the exact version goes in a tooltip. */
export function priceSentence(price: Price | null): {
  text: string;
  failed: boolean;
  detail?: string;
} {
  if (!price) return { text: "Price date unavailable.", failed: false };
  const detail = `${price.source} ${price.version}`;
  if (price.refreshFailed)
    return {
      text: `Price refresh failed. Last good ${price.source} prices, as of ${date(price.asOf)}.`,
      failed: true,
      detail,
    };
  if (price.basis === "baseline")
    return {
      text: `Baseline ${price.source} prices, as of ${date(price.asOf)}.`,
      failed: false,
      detail,
    };
  return {
    text: `Live ${price.source} prices, updated ${date(price.asOf)}.`,
    failed: false,
    detail,
  };
}
