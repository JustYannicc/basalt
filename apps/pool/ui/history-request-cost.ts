import type { PublicHistoryRecord } from "../history-contract.ts";
import { priceSentence, type Price } from "./price-text.ts";
import { decimal, money, provenance } from "./series-model.ts";
import { failedRecordWithoutUsage } from "./usage-outcome.ts";

// One request's current public USD estimate, read-time from the same rates as the aggregates. The
// retained charge is a different number in its own currency (often credits) and never stands in
// for it: a server that sent no estimate reads "Not reported", never $0.00 or a credit amount.

export interface RequestEstimate {
  readonly text: string;
  /** True only when `text` is a USD amount. */
  readonly priced: boolean;
  readonly price: Price | null;
  readonly reason: string | null;
}

const shown = (text: string, reason: string | null = null, price: Price | null = null) => ({
  text,
  priced: false,
  price,
  reason,
});

export function requestEstimate(record: PublicHistoryRecord): RequestEstimate {
  if (failedRecordWithoutUsage(record)) return shown("No usage recorded");
  const metric = record.api_estimate;
  if (!metric) return shown("Not reported", "This server doesn't report per-request estimates.");
  if (metric.status === "unavailable")
    return shown("Unavailable", metric.reason ?? "No reason was recorded.");
  const price = metric.price ? provenance(metric.price) : null;
  if (metric.amount === null) return shown("Unpriced", metric.reason ?? null, price);
  const amount = decimal(metric.amount);
  if (!amount) return shown("Unavailable", "The estimate wasn't a valid amount.");
  return { text: money({ currency: "USD", amount }), priced: true, price, reason: null };
}

/** The expanded row's account of where the estimate came from, or why there is none. */
export function requestEstimateBasis(estimate: RequestEstimate): string | null {
  if (estimate.reason) return estimate.reason;
  if (!estimate.price) return null;
  const { calculation, ...rates } = estimate.price;
  const sentence = priceSentence(rates).text;
  if (calculation !== "token-counts") return sentence;
  return `${sentence} Priced from its recorded token counts because usable API usage details were missing.`;
}

/** What was retained at capture, exactly as stored and in its own currency. */
export function recordedCost(record: PublicHistoryRecord): string {
  if (record.cost_basis === "unpriced" || record.cost === null) return "Not recorded";
  const basis = record.cost_basis === "home-charge" ? "Home charge" : "Historical API price";
  return `${record.cost} ${record.currency ?? "currency not recorded"} · ${basis}`;
}
