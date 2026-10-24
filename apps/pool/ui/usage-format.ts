import type { AccountsNeeded, DayUsage, ModelUsage, UsageSlice } from "../contract.ts";
import { clamp } from "./usage.ts";

export type Metric = "tokens" | "cost";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "12.4M", "860K", "312". */
export function tokens(value: number): string {
  return compact.format(Math.max(0, value));
}

/** "$84.20"; under a cent reads "<$0.01" so a tiny spend never looks free. */
export function cost(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return dollars.format(value);
}

export function value(slice: UsageSlice, metric: Metric): number {
  return metric === "tokens" ? slice.tokens.total : slice.cost;
}

export function format(amount: number, metric: Metric): string {
  return metric === "tokens" ? tokens(amount) : cost(amount);
}

const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/** "3 Oct", for a `YYYY-MM-DD` UTC day. */
export function dayLabel(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(at) ? day : dayFormat.format(at);
}

/** Every UTC day from `from` up to `to`, so the chart keeps its gaps. */
export function dayRange(from: string, to: string): string[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return [];
  const days: string[] = [];
  const first = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate());
  for (let at = first; at < end && days.length < 31; at += 86_400_000) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

/** One model through one provider; the same name can come through two. */
export const modelKey = (model: Pick<ModelUsage, "provider" | "model">) => `${model.provider}:${model.model}`;

/** The biggest models by the chosen metric, the rest folded into one "Other" series. */
export function series(models: readonly ModelUsage[], metric: Metric, limit = 4): { keys: string[]; other: boolean } {
  const ranked = rankModels(models, metric).filter((model) => value(model, metric) > 0);
  return { keys: ranked.slice(0, limit).map(modelKey), other: ranked.length > limit };
}

export interface Column {
  readonly day: string;
  readonly total: number;
  /** Per series key, plus "" for Other. */
  readonly parts: readonly { readonly key: string; readonly amount: number }[];
}

export function columns(days: readonly DayUsage[], range: readonly string[], keys: readonly string[], metric: Metric): Column[] {
  const byDay = new Map(days.map((day) => [day.day, day]));
  return range.map((day) => {
    const usage = byDay.get(day);
    if (!usage) return { day, total: 0, parts: [] };
    const parts = keys.map((key) => ({
      key,
      amount: usage.models.filter((model) => modelKey(model) === key).reduce((sum, model) => sum + value(model, metric), 0),
    }));
    const named = parts.reduce((sum, part) => sum + part.amount, 0);
    const total = value(usage, metric);
    return { day, total, parts: total - named > 0 ? [...parts, { key: "", amount: total - named }] : parts };
  });
}

/** Biggest first, then by name. */
export function rankModels(models: readonly ModelUsage[], metric: Metric): ModelUsage[] {
  return [...models].sort((a, b) => value(b, metric) - value(a, metric) || a.model.localeCompare(b.model));
}

export function share(part: number, whole: number): number {
  return whole > 0 ? clamp(part / whole) : 0;
}

/** The accounts-needed line, in the owner's words. */
export function advice(entry: AccountsNeeded, provider: string): string {
  const hits = `${entry.limitHits} ${entry.limitHits === 1 ? "time" : "times"}`;
  switch (entry.advice) {
    case "add":
      return `Add a ${provider} account. Every one was at its limit at once this week, so requests had nowhere to go.`;
    case "remove":
      return entry.accounts > 1
        ? `You could remove a ${provider} account. None hit a limit this week, and the rest always had room.`
        : `${provider} has room to spare.`;
    case "enough":
      return entry.limitHits > 0
        ? `${provider} accounts are enough. They hit a limit ${hits} this week, but another always had room.`
        : `${provider} accounts are enough.`;
    default:
      return `Not enough readings yet to say whether ${provider} needs another account.`;
  }
}
