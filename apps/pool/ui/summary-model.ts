import type { OverviewUsageSlice } from "../overview-contract.ts";
import type { UsageForecast, UsageForecasts } from "../usage-forecast-contract.ts";
import type {
  PoolUsageSummaryResult,
  UsageSummaryBucket,
  UsageSummaryGroup,
} from "../usage-overview-contract.ts";

// Pure readings of one summary answer. Nothing here decides health, plans or routing; a value the
// summary does not carry stays null so the page says "unknown" instead of drawing a zero.

export type Metric = "cost" | "tokens" | "requests";
export type Breakdown = "provider" | "model";
export type RangeDays = 7 | 30 | 90;

export interface Total {
  /** Sum of the known values; null when no bucket carried the metric. */
  readonly value: number | null;
  /** Requests whose bucket lacked the metric, such as counts-only or unpriced usage. */
  readonly missing: number;
}

const zurichDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const zurichClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Zurich",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

/** The Zurich calendar day of an instant, as `YYYY-MM-DD`. */
export const zurichDay = (at: string | number) => zurichDate.format(new Date(at));

function zurichOffset(at: number) {
  const parts = Object.fromEntries(
    zurichClock.formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
  return wall - Math.floor(at / 60_000) * 60_000;
}

/** Midnight of a Zurich day. DST changes at 02:00/03:00, so midnight's offset is that day's own. */
export function zurichMidnight(day: string) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  return guess - zurichOffset(guess - zurichOffset(guess));
}

/** The longest span the summary and capacity reads accept, in elapsed days. */
export const maxRangeDays = 400;
const dayMs = 86_400_000;

/** A fixed window, or everything since the pool's first retained request, bounded to 400 days. */
export type RangeChoice =
  | { readonly kind: "days"; readonly days: RangeDays }
  | { readonly kind: "since"; readonly first: string };

export const rangeKey = (choice: RangeChoice) =>
  choice.kind === "days" ? String(choice.days) : `since ${choice.first}`;

export interface SummaryBounds {
  readonly from: string;
  readonly to: string;
  /** Whole days the capacity read covers for the same end. */
  readonly days: number;
  /** The since-start window hit the 400-day limit, so older retained requests are outside it. */
  readonly bounded: boolean;
}

/**
 * Whole Zurich days ending with today, so each daily bucket is a full calendar day but today. A
 * since-start window begins at the Zurich midnight before the first retained request, never earlier
 * than the first whole day inside the 400-day limit.
 */
export function summaryRange(choice: RangeChoice, now: number): SummaryBounds {
  if (choice.kind === "days") {
    const today = zurichMidnight(zurichDay(now));
    const first = zurichMidnight(zurichDay(today - (choice.days - 1) * dayMs + 12 * 3_600_000));
    return {
      from: new Date(first).toISOString(),
      to: new Date(now).toISOString(),
      days: choice.days,
      bounded: false,
    };
  }
  const limit = now - maxRangeDays * dayMs;
  let start = zurichMidnight(zurichDay(choice.first));
  const bounded = start < limit;
  if (bounded) {
    start = zurichMidnight(zurichDay(limit));
    if (start < limit) start = zurichMidnight(zurichDay(start + 36 * 3_600_000));
  }
  return {
    from: new Date(start).toISOString(),
    to: new Date(now).toISOString(),
    days: Math.min(maxRangeDays, Math.max(1, Math.ceil((now - start) / dayMs))),
    bounded,
  };
}

/**
 * What the member route is asked for: its own fixed windows only. A since-start choice falls back to
 * the last 7 days, sent with their own bounds, never the dynamic range.
 */
export function personalRange(choice: RangeChoice, bounds: SummaryBounds, now: number) {
  if (choice.kind === "days") return { from: bounds.from, to: bounds.to, days: choice.days };
  const week = summaryRange({ kind: "days", days: 7 }, now);
  return { from: week.from, to: week.to, days: 7 as const };
}

/** The since-start option, only when the pool's first retained request is known. */
export function sinceOption(retainedFirstAt: string | null | undefined, now: number) {
  if (typeof retainedFirstAt !== "string") return null;
  const first = Date.parse(retainedFirstAt);
  if (!Number.isFinite(first) || first > now) return null;
  const choice: RangeChoice = { kind: "since", first: retainedFirstAt };
  return { choice, bounds: summaryRange(choice, now) };
}

export function bucketValue(bucket: UsageSummaryBucket, metric: Metric): number | null {
  if (metric === "requests") return bucket.requests;
  if (bucket.details === null) return null;
  if (metric === "tokens") {
    const sum = bucket.details.tokens.total.sum;
    return sum === null ? null : Number(sum);
  }
  const money = bucket.details.apiEstimate;
  return money.status === "available" && money.amount !== null ? Number(money.amount) : null;
}

export function groupTotal(group: UsageSummaryGroup, metric: Metric): Total {
  let value: number | null = null;
  let missing = 0;
  for (const bucket of group.buckets) {
    const known = bucketValue(bucket, metric);
    if (known !== null) value = (value ?? 0) + known;
    // A known sum can still leave some requests without the metric: unpriced requests, or rows
    // whose source reported no token counts. Counts-only buckets lack it for every request.
    missing +=
      metric === "requests"
        ? 0
        : bucket.details === null
          ? bucket.requests
          : metric === "cost"
            ? bucket.requests - bucket.details.apiEstimate.pricedRequests
            : known === null
              ? bucket.requests
              : bucket.details.tokens.total.missing;
  }
  return { value, missing };
}

export function total(groups: readonly UsageSummaryGroup[], metric: Metric): Total {
  return groups.reduce<Total>(
    (sum, group) => {
      const next = groupTotal(group, metric);
      return {
        value: next.value === null ? sum.value : (sum.value ?? 0) + next.value,
        missing: sum.missing + next.missing,
      };
    },
    { value: null, missing: 0 },
  );
}

/** Priced and unpriced request counts behind the current API estimate. */
export function pricing(groups: readonly UsageSummaryGroup[]) {
  let priced = 0;
  let unpriced = 0;
  let countsOnly = 0;
  for (const group of groups)
    for (const bucket of group.buckets) {
      if (bucket.details === null) countsOnly += bucket.requests;
      else {
        priced += bucket.details.apiEstimate.pricedRequests;
        unpriced += bucket.details.apiEstimate.excluded.unpriced;
      }
    }
  return { priced, unpriced, countsOnly };
}

/**
 * Cache reads as a share of tokens, over buckets whose cache and total counts are both known.
 * `partial` says some buckets were left out, so the share describes only the counted ones.
 */
export function cacheShare(groups: readonly UsageSummaryGroup[]) {
  let cache = 0;
  let all = 0;
  let partial = false;
  for (const group of groups)
    for (const bucket of group.buckets) {
      const tokens = bucket.details?.tokens;
      if (
        tokens === undefined ||
        tokens.total.sum === null ||
        tokens.cacheRead.sum === null ||
        tokens.total.missing > 0 ||
        tokens.cacheRead.missing > 0
      ) {
        if (bucket.requests > 0) partial = true;
        continue;
      }
      cache += Number(tokens.cacheRead.sum);
      all += Number(tokens.total.sum);
    }
  return { share: all > 0 ? cache / all : null, partial };
}

/** Runs of consecutive known values; an unknown day breaks the line instead of reading as zero. */
export function knownRuns(values: readonly (number | null)[]) {
  const runs: { readonly index: number; readonly value: number }[][] = [];
  let run: { index: number; value: number }[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push({ index, value });
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

/** Change against the previous equal range; null when either side is unknown or the base is zero. */
export const delta = (current: number | null, previous: number | null) =>
  current === null || previous === null || previous === 0 ? null : (current - previous) / previous;

export const groupKey = (group: UsageSummaryGroup, by: Breakdown) =>
  (by === "model" ? group.model : group.provider) ?? null;

export interface Day {
  readonly day: string;
  readonly partial: boolean;
  /** Per group key, in `keys` order; null when that group's day lacks the metric. */
  readonly values: readonly (number | null)[];
}

export interface Stack {
  readonly keys: readonly (string | null)[];
  readonly days: readonly Day[];
}

/** One column per Zurich day the summary returned, one stacked part per group. */
export function stack(groups: readonly UsageSummaryGroup[], by: Breakdown, metric: Metric): Stack {
  const keys = [...new Set(groups.map((group) => groupKey(group, by)))];
  const days = new Map<string, { partial: boolean; values: (number | null)[] }>();
  for (const group of groups) {
    const index = keys.indexOf(groupKey(group, by));
    for (const bucket of group.buckets) {
      const day = zurichDay(bucket.at);
      const entry = days.get(day) ?? {
        partial: false,
        values: keys.map((): number | null => null),
      };
      const value = bucketValue(bucket, metric);
      entry.partial ||= bucket.partial;
      if (value !== null) entry.values[index] = (entry.values[index] ?? 0) + value;
      days.set(day, entry);
    }
  }
  return {
    keys,
    days: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, entry]) => ({ day, ...entry })),
  };
}

export const dayTotal = (day: Day) =>
  day.values.some((value) => value !== null)
    ? day.values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;

export interface BreakdownRow {
  readonly key: string | null;
  readonly total: Total;
  readonly requests: number;
  readonly share: number | null;
  /** Current official API cost from the summary's usage slices, by the same key. */
  readonly cost: { readonly amount: number | null; readonly unpriced: number };
}

export function breakdown(
  groups: readonly UsageSummaryGroup[],
  slices: readonly OverviewUsageSlice[],
  by: Breakdown,
  metric: Metric,
): BreakdownRow[] {
  const keys = [...new Set(groups.map((group) => groupKey(group, by)))];
  const all = total(groups, metric).value;
  return keys
    .map((key) => {
      const own = groups.filter((group) => groupKey(group, by) === key);
      const sum = total(own, metric);
      const mine = slices.filter(
        (slice) => (by === "model" ? slice.model : slice.provider) === key,
      );
      const priced = mine.filter((slice) => slice.apiBilled !== null);
      return {
        key,
        total: sum,
        requests: total(own, "requests").value ?? 0,
        share: sum.value === null || !all ? null : sum.value / all,
        cost: {
          amount:
            priced.length === 0
              ? null
              : priced.reduce((amount, slice) => amount + Number(slice.apiBilled), 0),
          unpriced: mine.reduce((count, slice) => count + slice.apiUnpriced, 0),
        },
      };
    })
    .sort((a, b) => (b.total.value ?? -1) - (a.total.value ?? -1) || b.requests - a.requests);
}

const forecastMetric = { cost: "apiEstimate", tokens: "tokens", requests: "requests" } as const;

/** The producer's forecast for one lab, or the pool when `provider` is null. */
export function forecastFor(
  forecasts: UsageForecasts,
  provider: string | null,
  metric: Metric,
): UsageForecast | undefined {
  return forecasts.series.find((series) => series.provider === provider)?.[forecastMetric[metric]];
}

/** Hours of the heatmap as the producer averaged them: tokens per sampled hour, per lab or all. */
export function heat(summary: PoolUsageSummaryResult["heatmap"], provider: string | null = null) {
  const cells = new Map<string, { tokens: number; hours: number; unknown: boolean }>();
  for (const cell of summary.cells) {
    if (provider !== null && cell.provider !== provider) continue;
    const key = `${cell.weekday}:${cell.hour}`;
    const entry = cells.get(key) ?? { tokens: 0, hours: 0, unknown: false };
    if (cell.tokens.sum === null) entry.unknown = true;
    else entry.tokens += Number(cell.tokens.sum);
    entry.hours = Math.max(entry.hours, cell.sampleHours);
    cells.set(key, entry);
  }
  return (weekday: number, hour: number) => {
    const entry = cells.get(`${weekday}:${hour}`);
    if (entry === undefined || entry.hours === 0) return null;
    return entry.unknown && entry.tokens === 0 ? null : entry.tokens / entry.hours;
  };
}

/**
 * Failures worth an alert now: real failures in the last hour. A 499 is a client that hung up,
 * never the pool failing, so it is dropped even if a producer reports it.
 */
export function incident(incidents: PoolUsageSummaryResult["incidents"]) {
  if (incidents.status === "unavailable") return { state: "unknown" as const };
  const failures = incidents.failures
    .filter((failure) => failure.status !== 499)
    .sort((a, b) => b.count - a.count);
  const hungUp = incidents.failures
    .filter((failure) => failure.status === 499)
    .reduce((count, failure) => count + failure.count, 0);
  const failed = Math.max(0, incidents.failed - hungUp);
  const partial = incidents.status === "partial";
  if (failed === 0) return { state: "clear" as const, partial };
  return { state: "failing" as const, partial, failed, requests: incidents.requests, failures };
}
