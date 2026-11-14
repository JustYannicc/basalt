import { cost, tokens } from "./usage-format.ts";
import { zurichDay, type Metric } from "./summary-model.ts";

const count = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en");
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 0 });

export const metricLabel: Record<Metric, string> = {
  cost: "Est. cost",
  tokens: "Tokens",
  requests: "Requests",
};

/** A known value in its metric's unit; unknown reads as a dash with a reason nearby. */
export function formatMetric(metric: Metric, value: number | null): string {
  if (value === null) return "—";
  if (metric === "cost") return cost(value);
  if (metric === "tokens") return tokens(value);
  return value < 10_000 ? whole.format(Math.round(value)) : count.format(value);
}

export const formatCount = (value: number) => whole.format(value);
export const formatShare = (value: number) => percent.format(value);

/** "+12%", "−4%", or "no change"; null when there is nothing to compare with. */
export function formatDelta(value: number | null): string | null {
  if (value === null) return null;
  const rounded = Math.round(value * 100);
  if (rounded === 0) return "no change";
  return `${rounded > 0 ? "+" : "−"}${percent.format(Math.abs(value))}`;
}

const dayShort = new Intl.DateTimeFormat("en", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const weekdayShort = new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "short" });

/** A calendar day, or an instant read as its Zurich day, so it is the same date in every browser. */
export const calendarDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : zurichDay(value);
const noon = (value: string) => new Date(`${calendarDay(value)}T12:00:00Z`);
export const formatDay = (day: string) => dayShort.format(noon(day));
export const formatWeekday = (day: string) => weekdayShort.format(noon(day));
export const formatMonth = (day: string) =>
  new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(noon(day));

export const plural = (n: number, one: string, many: string) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;
