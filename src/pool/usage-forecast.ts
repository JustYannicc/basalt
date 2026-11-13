import type {
  UsageDay,
  UsageForecast,
  UsageMiss,
  UsageProjection,
} from "../../apps/pool/usage-forecast-contract.ts";
import {
  addUsageDays,
  usageDay,
  usageDayStart,
  usageMonday,
  usageWeekday,
  validUsageDay,
} from "./usage-calendar.ts";

const trainingCount = 4;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

function pattern(weeks: readonly (readonly number[])[]) {
  const total = median(weeks.map(sum));
  const shape = Array.from({ length: 7 }, (_, day) => sum(weeks.map((week) => week[day]!)));
  const shapeTotal = sum(shape);
  return { total, shape: shape.map((value) => (shapeTotal > 0 ? value / shapeTotal : 1 / 7)) };
}

export function usageForecast(input: {
  readonly days: readonly UsageDay[];
  readonly calculatedAt: string;
}): UsageForecast {
  const now = Date.parse(input.calculatedAt);
  let comparableWeeks = 0;
  const unavailable = (
    reason: "invalid-input" | "insufficient-history" | "insufficient-use",
  ): UsageForecast => ({
    status: "unavailable",
    reason,
    comparableWeeks,
    calculatedAt: input.calculatedAt,
  });
  if (!Number.isFinite(now) || input.days.length > 401) return unavailable("invalid-input");
  const today = usageDay(now);
  const days = new Map<string, UsageDay>();
  for (const day of input.days) {
    if (!validUsageDay(day.day)) return unavailable("invalid-input");
    if (day.day > today) continue;
    if (
      days.has(day.day) ||
      !Number.isSafeInteger(day.requests) ||
      day.requests < 0 ||
      (day.value !== null && (!Number.isFinite(day.value) || day.value < 0))
    )
      return unavailable("invalid-input");
    days.set(day.day, day);
  }
  const monday = usageMonday(today);
  const weeks = new Map<string, number[]>();
  const first = [...days.keys()].sort()[0];
  if (!first) return unavailable("insufficient-history");
  if (first < addUsageDays(today, -400)) return unavailable("invalid-input");
  for (let at = usageMonday(first); at < monday; at = addUsageDays(at, 7)) {
    const values = Array.from({ length: 7 }, (_, day) => days.get(addUsageDays(at, day))?.value);
    if (values.every((value): value is number => typeof value === "number")) weeks.set(at, values);
  }
  comparableWeeks = weeks.size;
  const trainingWeeks = Array.from({ length: trainingCount }, (_, index) =>
    addUsageDays(monday, (index - trainingCount) * 7),
  );
  if (trainingWeeks.some((week) => !weeks.has(week))) return unavailable("insufficient-history");
  const recent = [...days.values()].filter((day) => day.day >= addUsageDays(today, -29));
  if (sum(recent.map((day) => day.requests)) < 1000) return unavailable("insufficient-use");
  const fitted = pattern(trainingWeeks.map((week) => weeks.get(week)!));
  const misses: UsageMiss[] = [];
  for (const [week, values] of weeks) {
    const past = Array.from({ length: trainingCount }, (_, index) =>
      weeks.get(addUsageDays(week, (index - trainingCount) * 7)),
    );
    if (!past.every((value): value is number[] => value !== undefined)) continue;
    const predicted = pattern(past).total;
    const actual = sum(values);
    const error = actual - predicted;
    misses.push({
      week,
      predicted,
      actual,
      error,
      share: actual > 0 ? Math.abs(error) / actual : error === 0 ? 0 : null,
    });
  }
  // The held-out weeks use the production estimator. A small sample stays visible and Low.
  const recentMisses = misses.slice(-8);
  const errors = recentMisses.map((miss) => Math.abs(miss.error)).sort((a, b) => a - b);
  const radius = errors.length >= 2 ? errors[Math.ceil(errors.length * 0.8) - 1]! : null;
  const steady = (bound: number) =>
    recentMisses.every((miss) => miss.share !== null && miss.share <= bound);
  const confidence =
    recentMisses.length >= 8 && steady(0.15)
      ? "High"
      : recentMisses.length >= 2 && steady(0.25)
        ? "Medium"
        : "Low";
  const todayFraction =
    (now - usageDayStart(today)) / (usageDayStart(addUsageDays(today, 1)) - usageDayStart(today));
  const project = (from: string, through: string): UsageProjection => {
    let actual = 0;
    let remaining = 0;
    let known = true;
    for (let at = from; at < through; at = addUsageDays(at, 1)) {
      if (at < today) {
        const value = days.get(at)?.value;
        if (typeof value !== "number") known = false;
        else actual += value;
      } else {
        if (at === today) {
          const current = days.get(at)?.value;
          if (current === null) known = false;
          actual += current ?? 0;
        }
        remaining += fitted.shape[usageWeekday(at)]! * (at === today ? 1 - todayFraction : 1);
      }
    }
    const center = actual + fitted.total * remaining;
    return {
      from,
      through,
      actual: known ? actual : null,
      median: known ? center : null,
      low: known && radius !== null ? Math.max(actual, center - radius * remaining) : null,
      high: known && radius !== null ? center + radius * remaining : null,
    };
  };
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1))
    .toISOString()
    .slice(0, 10);
  const nextMonday = addUsageDays(monday, 7);
  const horizon = monthEnd > addUsageDays(nextMonday, 7) ? monthEnd : addUsageDays(nextMonday, 7);
  const daily = [];
  for (let at = today; at < horizon; at = addUsageDays(at, 1)) {
    const share = fitted.shape[usageWeekday(at)]! * (at === today ? 1 - todayFraction : 1);
    daily.push({
      day: at,
      median: fitted.total * share,
      low: radius === null ? null : Math.max(0, fitted.total - radius) * share,
      high: radius === null ? null : (fitted.total + radius) * share,
    });
  }
  return {
    status: "available",
    calculatedAt: input.calculatedAt,
    timezone: "Europe/Zurich",
    method: "Median of the last 4 full weeks, shaped by day of week",
    confidence,
    coverage: { basis: "recorded-total", excludedRequests: 0 },
    interval: 0.8,
    comparableWeeks,
    trainingWeeks,
    misses: recentMisses,
    thisWeek: project(monday, nextMonday),
    nextWeek: project(nextMonday, addUsageDays(nextMonday, 7)),
    month: project(monthStart, monthEnd),
    daily,
  };
}
