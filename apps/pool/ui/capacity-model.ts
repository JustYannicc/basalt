import { accountPlanName } from "apps";
import type {
  CapacityAggregate,
  CapacityForecast,
  CapacityForecastShortfall,
  CapacityHistoryPoint,
  CapacityRefillEvent,
  CapacityWeightSource,
  PoolCapacityHistory,
} from "../capacity-contract.ts";

// One line per provider window and unit. History preserves gaps; forecast and refill data stay
// separate from measured points. A window a lab doesn't report simply has no line.

export const hourMs = 3_600_000;
export const dayMs = 24 * hourMs;
/** At or under this share of full counts as out, so rounding never hides an empty pool. */
const outShare = 0.01;

export interface CapacityLine {
  readonly key: string;
  readonly windowSeconds: number;
  readonly mode: string | null;
  readonly unit: { readonly id: string; readonly label: string };
  readonly label: string;
  /** Oldest first, one per measured hour. */
  readonly points: readonly CapacityHistoryPoint[];
  readonly forecast: CapacityForecast | null;
  readonly refills: readonly CapacityRefillEvent[];
}

export interface CapacityLab {
  readonly provider: string;
  readonly readAt: number | null;
  /** Longest window first, so Weekly reads before 5-hour. */
  readonly lines: readonly CapacityLine[];
  readonly weeklyAccounts: number;
  readonly fiveHourAccounts: number;
}

export function windowLabel(seconds: number): string {
  if (seconds === 5 * 3600) return "5-hour";
  if (seconds === 7 * 86400) return "Weekly";
  if (seconds === 86400) return "Daily";
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return `${Math.round(seconds / 60)}-minute`;
}

export function capacityLabs(history: PoolCapacityHistory): CapacityLab[] {
  const labs = new Map<string, Map<string, CapacityHistoryPoint[]>>();
  for (const point of history.points) {
    const key = JSON.stringify([point.provider, point.windowSeconds, point.mode, point.unit.id]);
    const lines = labs.get(point.provider) ?? new Map<string, CapacityHistoryPoint[]>();
    labs.set(point.provider, lines);
    lines.set(key, [...(lines.get(key) ?? []), point]);
  }
  return [...labs].map(([provider, lines]) => {
    const built = [...lines].map(([key, points]) => {
      const first = points[0]!;
      const label = windowLabel(first.windowSeconds) + (first.mode ? ` · ${first.mode}` : "");
      const forecast =
        history.forecasts.find(
          (entry) =>
            entry.provider === first.provider &&
            entry.windowSeconds === first.windowSeconds &&
            entry.mode === first.mode &&
            entry.unit.id === first.unit.id,
        ) ?? null;
      const refills = history.refillEvents.filter(
        (entry) =>
          entry.provider === first.provider &&
          entry.windowSeconds === first.windowSeconds &&
          entry.mode === first.mode &&
          entry.unitId === first.unit.id,
      );
      return {
        key,
        windowSeconds: first.windowSeconds,
        mode: first.mode,
        unit: first.unit,
        label,
        points: [...points].sort((a, b) => a.hour - b.hour),
        forecast,
        refills,
      };
    });
    // Two units on one window would otherwise share a label.
    const named = built.map((line) =>
      built.some((other) => other !== line && other.label === line.label)
        ? { ...line, label: `${line.label} · ${line.unit.label}` }
        : line,
    );
    const ordered = named.sort(
      (a, b) => b.windowSeconds - a.windowSeconds || a.label.localeCompare(b.label),
    );
    return {
      provider,
      readAt: history.readAt,
      lines: ordered,
      weeklyAccounts:
        ordered.find((line) => line.windowSeconds === 604_800)?.points.at(-1)?.last.accountCount ??
        0,
      fiveHourAccounts:
        ordered.find((line) => line.windowSeconds === 18_000)?.points.at(-1)?.last.accountCount ??
        0,
    };
  });
}

export const share = (aggregate: Pick<CapacityAggregate, "remaining" | "full">) =>
  aggregate.full > 0 ? Math.max(0, Math.min(1, aggregate.remaining / aggregate.full)) : null;

export function isMeasuredCapacityPoint(point: CapacityHistoryPoint): boolean {
  return (
    point.windowSeconds !== 18_000 ||
    (point.raw !== undefined && point.usable !== null && point.usable !== undefined)
  );
}

export const isOut = (point: CapacityHistoryPoint) =>
  isMeasuredCapacityPoint(point) &&
  point.minimum.full > 0 &&
  point.minimum.remaining <= point.minimum.full * outShare;

export interface Span {
  readonly from: number;
  readonly to: number;
}

/** Runs of consecutive measured hours, split wherever an hour has no reading. */
export function segments(points: readonly CapacityHistoryPoint[]): CapacityHistoryPoint[][] {
  const out: CapacityHistoryPoint[][] = [];
  for (const point of points) {
    const run = out.at(-1);
    if (run && point.hour - run.at(-1)!.hour === hourMs) run.push(point);
    else out.push([point]);
  }
  return out;
}

/** Hours with no reading between the first reading and `to`. Before the first reading is "not tracked yet". */
export function gaps(points: readonly CapacityHistoryPoint[], to: number): Span[] {
  const out: Span[] = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1]!.hour + hourMs;
    if (points[index]!.hour > from) out.push({ from, to: points[index]!.hour });
  }
  const last = points.at(-1);
  // The current hour may simply not be sampled yet; only a full missing hour is a gap.
  if (last && to - (last.hour + hourMs) >= hourMs) out.push({ from: last.hour + hourMs, to });
  return out;
}

export function outSpans(points: readonly CapacityHistoryPoint[]): Span[] {
  const out: Span[] = [];
  for (const point of points) {
    if (!isOut(point)) continue;
    const last = out.at(-1);
    if (last && last.to === point.hour)
      out[out.length - 1] = { from: last.from, to: point.hour + hourMs };
    else out.push({ from: point.hour, to: point.hour + hourMs });
  }
  return out;
}

export interface LineFacts {
  readonly asOf: number;
  readonly latest: CapacityHistoryPoint | null;
  readonly lowest: CapacityHistoryPoint | null;
  /** The lowest observed point in each UTC week, shown on weekly lines. */
  readonly weeklyLows: readonly CapacityHistoryPoint[];
  readonly outHours: number;
  readonly episodes: number;
  readonly longestHours: number;
  readonly gapHours: number;
  readonly measuredHours: number;
}

export function lineFacts(line: CapacityLine, to: number): LineFacts {
  const points = line.points.filter(isMeasuredCapacityPoint);
  const spans = outSpans(points);
  const lengths = spans.map((span) => (span.to - span.from) / hourMs);
  let lowest: CapacityHistoryPoint | null = null;
  for (const point of points) {
    if (!lowest || point.minimum.remaining < lowest.minimum.remaining) lowest = point;
  }
  const lows = new Map<number, CapacityHistoryPoint>();
  if (line.windowSeconds === 604_800)
    for (const point of points) {
      const week = Math.floor((point.hour + 3 * dayMs) / (7 * dayMs));
      const known = lows.get(week);
      if (!known || point.minimum.remaining < known.minimum.remaining) lows.set(week, point);
    }
  return {
    asOf: to,
    latest: points.at(-1) ?? null,
    lowest,
    weeklyLows: [...lows.values()],
    outHours: lengths.reduce((sum, hours) => sum + hours, 0),
    episodes: spans.length,
    longestHours: Math.max(0, ...lengths),
    gapHours: gaps(points, to).reduce((sum, span) => sum + (span.to - span.from) / hourMs, 0),
    measuredHours: points.length,
  };
}

/**
 * Which window opens first: one that is out now, then the earlier projected run-out, then the one
 * with less left at its latest reading. `withheld` marks an incomplete read: its forecasts are not
 * used, and the note never blames a forecast for that.
 */
export function pressing(
  lab: CapacityLab,
  asOf = lab.readAt,
  { withheld = false }: { readonly withheld?: boolean } = {},
): { readonly key: string; readonly text: string | null } {
  const weeklyLines = lab.lines.filter((line) => line.windowSeconds === 604_800);
  const fiveLines = lab.lines.filter((line) => line.windowSeconds === 18_000);
  const weekly = weeklyLines[0];
  const five = fiveLines[0];
  const fallback = lab.lines[0];
  if (!weekly || !five) return { key: fallback?.key ?? "", text: null };
  const isFresh = (line: CapacityLine) => {
    const latest = line.points.filter(isMeasuredCapacityPoint).at(-1);
    return Boolean(
      latest &&
      asOf !== null &&
      asOf >= latest.last.observedAt.to &&
      asOf - latest.last.observedAt.from <= 6 * 60_000,
    );
  };
  const exhaustedNow = (line: CapacityLine) => {
    const latest = line.points.filter(isMeasuredCapacityPoint).at(-1);
    return Boolean(
      isFresh(line) &&
      latest!.last.full > 0 &&
      latest!.last.remaining <= latest!.last.full * outShare,
    );
  };
  const forecastReady = (line: CapacityLine) =>
    !withheld && line.forecast?.status === "estimated" && line.forecast.points.length > 0;
  const projectedRunOut = (line: CapacityLine) =>
    forecastReady(line) ? line.forecast!.runsOutAt : null;
  const readyLines = lab.lines.filter(forecastReady);
  const exhausted = lab.lines
    .filter(exhaustedNow)
    .sort((a, b) => b.windowSeconds - a.windowSeconds);
  const projected = readyLines
    .filter((line) => projectedRunOut(line) !== null)
    .sort((a, b) => projectedRunOut(a)! - projectedRunOut(b)!);
  const first = exhausted[0] ?? projected[0];
  const counterpart = (line: CapacityLine) =>
    lab.lines.find(
      (entry) =>
        entry.windowSeconds !== line.windowSeconds &&
        entry.unit.id === line.unit.id &&
        entry.mode === line.mode,
    ) ?? lab.lines.find((entry) => entry.windowSeconds !== line.windowSeconds);
  const at = (line: CapacityLine) => {
    const nowOut =
      exhaustedNow(line) ||
      (projectedRunOut(line) !== null && line.forecast!.runsOutAt! <= line.forecast!.points[0]!.at);
    const runOut = projectedRunOut(line);
    const missing = withheld
      ? "forecast withheld"
      : !line.forecast || line.forecast.status === "learning"
        ? "forecast learning"
        : "forecast unavailable";
    return nowOut
      ? "out now"
      : runOut === null
        ? forecastReady(line)
          ? "doesn't run out"
          : missing
        : `out ~${whenLabel(runOut)}`;
  };
  if (first) {
    const other = counterpart(first);
    return {
      key: first.key,
      text: `${first.label} is more pressing: ${at(first)}; ${other?.label.toLowerCase() ?? "other window"} ${other ? at(other) : "is unavailable"}`,
    };
  }
  // Nothing runs out: the window with less left now is the one to watch.
  const left = (line: CapacityLine) => {
    const latest = line.points.filter(isMeasuredCapacityPoint).at(-1);
    return latest && latest.last.full > 0 ? latest.last.remaining / latest.last.full : null;
  };
  const weeklyLeft = left(weekly);
  const fiveLeft = left(five);
  if (weeklyLeft !== null && fiveLeft !== null) {
    const chosen = fiveLeft < weeklyLeft ? five : weekly;
    const percent = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
    // An old reading is reported as such, never as the balance now.
    const when = isFresh(weekly) && isFresh(five) ? "left now" : "left at the last reading";
    return {
      key: chosen.key,
      text: `${chosen.label} is more pressing: ${percent(Math.min(weeklyLeft, fiveLeft))} ${when} vs ${percent(Math.max(weeklyLeft, fiveLeft))}`,
    };
  }
  if (withheld) return { key: weekly.key, text: null };
  const bothForecastsReady = weeklyLines.every(forecastReady) && fiveLines.every(forecastReady);
  const stillLearning = [weekly, five].some(
    (line) => !line.forecast || line.forecast.status === "learning",
  );
  const text = bothForecastsReady
    ? "No window projects a run-out in the next 72 hours; showing Weekly."
    : stillLearning
      ? "Forecast learning; showing Weekly."
      : "Forecast unavailable; showing Weekly.";
  return { key: weekly.key, text };
}

/** Answer-row and panel verdict use the same projected result. */
export function verdict(
  line: CapacityLine | undefined,
  facts: LineFacts | undefined,
  days: number,
): {
  readonly tone: "ok" | "warn" | "learn";
  readonly short: string;
  readonly text: string;
  readonly detail: string | null;
} {
  const forecast = line?.forecast;
  if (
    line?.windowSeconds === 18_000 &&
    line.points.length > 0 &&
    !line.points.some(isMeasuredCapacityPoint)
  ) {
    return {
      tone: "learn",
      short: "Weekly balance unavailable",
      text: "Five-hour readings cannot be treated as usable without matching weekly balances for the same accounts.",
      detail: null,
    };
  }
  if (!line || !facts?.latest || !forecast || forecast.status === "learning") {
    const weeks = forecast?.history.completedWeeks ?? 0;
    return {
      tone: "learn",
      short: "Learning",
      text: `${facts?.measuredHours ?? 0} hours of readings in the last ${days} days. The forecast starts after 2 completed weeks; advice starts after 4.`,
      detail: `${weeks} completed ${weeks === 1 ? "week" : "weeks"}. No projection or account count yet.`,
    };
  }
  if (forecast.status === "unavailable")
    return {
      tone: "learn",
      short: "Unavailable",
      text: "The capacity forecast is unavailable.",
      detail: forecast.reasons.length
        ? `Reason: ${forecastReasons(forecast.reasons).join("; ")}.`
        : null,
    };
  if (forecast.points.length === 0)
    return {
      tone: "learn",
      short: "Unavailable",
      text: "The capacity forecast has no projection points.",
      detail: null,
    };
  const projectedOut = forecast.runsOutAt !== null;
  const low = Math.min(...forecast.points.map((point) => point.median));
  const outNow =
    facts.latest.last.full > 0 &&
    facts.latest.last.remaining <= facts.latest.last.full * outShare &&
    facts.asOf >= facts.latest.last.observedAt.to &&
    facts.asOf - facts.latest.last.observedAt.from <= 6 * 60_000;
  const horizonEnd = forecast.points.at(-1)!.at + hourMs;
  const dryStretch = forecast.ordinary?.stretches.find(
    (stretch) =>
      forecast.runsOutAt !== null &&
      stretch.from <= forecast.runsOutAt &&
      stretch.to > forecast.runsOutAt,
  );
  const recovery = dryStretch && dryStretch.to < horizonEnd ? dryStretch.to : null;
  const projected = projectedOut
    ? `${outNow ? "Out now" : `Out from ~${whenLabel(forecast.runsOutAt!)}`}${recovery === null ? "" : `; usable capacity returns ~${whenLabel(recovery)}`}.`
    : `Projected low ${amount(low)} ${line.unit.label} over the next 72 hours.`;
  const shortfall = forecast.ordinary?.amount ?? 0;
  const busy = forecast.busy?.amount ?? 0;
  const explain =
    shortfall > 0
      ? `Projected short ${amount(shortfall)} ${line.unit.label}${busy > shortfall ? `, ${amount(busy)} on the busy path` : ""}.`
      : busy > 0
        ? `No median shortfall. The busy path is short ${amount(busy)} ${line.unit.label}.`
        : "No projected shortfall in the next 72 hours.";
  const sizingCount = Math.max(forecast.ordinary?.accounts ?? 0, forecast.busy?.accounts ?? 0);
  const sizingNeed = sizingCount > 0;
  const sizingBasis =
    forecast.ordinary?.accountBasis === "sustained-trend"
      ? "the sustained demand rise"
      : "recurring demand peaks";
  const sizingDetail = sizingNeed
    ? `Sizing for ${sizingBasis} needs up to ${sizingCount} more ${forecast.ordinary?.candidate ? candidateName(forecast.ordinary.candidate, forecast.provider) : "verified-plan"} accounts on the busy path.`
    : null;
  const short =
    sizingNeed && !projectedOut && shortfall === 0 && busy === 0
      ? "More accounts advised"
      : projectedOut || shortfall > 0
        ? "Runs short"
        : busy > 0
          ? "Busy path short"
          : "Enough";
  const flagged = facts.latest.last.unknownWeightCount;
  return {
    tone: projectedOut || shortfall > 0 || busy > 0 || sizingNeed ? "warn" : "ok",
    short,
    text: `${projected} ${explain}`,
    detail:
      [
        sizingDetail,
        flagged
          ? `${flagged} of ${facts.latest.last.accountCount} accounts count at a flagged 1x. If their real weight is higher, the shortfall is smaller than shown.`
          : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
  };
}

export interface DailyRow {
  readonly day: number;
  /** The day's lowest reading, or null with no reading at all. */
  readonly lowest: CapacityAggregate | null;
  readonly outHours: number;
  /** Hours since the first reading with none of their own. */
  readonly missingHours: number;
}

/** One row per UTC day from the first reading to `to`, newest first: the chart's table fallback. */
export function dailyRows(points: readonly CapacityHistoryPoint[], to: number): DailyRow[] {
  const measured = points.filter(isMeasuredCapacityPoint);
  const first = measured[0];
  if (!first) return [];
  const days = new Map<
    number,
    { lowest: CapacityAggregate | null; out: number; measured: number }
  >();
  for (let day = Math.floor(first.hour / dayMs) * dayMs; day < to; day += dayMs)
    days.set(day, { lowest: null, out: 0, measured: 0 });
  for (const point of measured) {
    const row = days.get(Math.floor(point.hour / dayMs) * dayMs);
    if (!row) continue;
    row.measured++;
    if (isOut(point)) row.out++;
    if (!row.lowest || point.minimum.remaining < row.lowest.remaining) row.lowest = point.minimum;
  }
  return [...days]
    .map(([day, row]) => {
      const start = Math.max(day, first.hour);
      const end = Math.min(day + dayMs, Math.floor(to / hourMs) * hourMs);
      return {
        day,
        lowest: row.lowest,
        outHours: row.out,
        missingHours: Math.max(0, (end - start) / hourMs - row.measured),
      };
    })
    .reverse();
}

export interface PlanChip {
  readonly key: string;
  readonly plan: string;
  readonly accounts: number;
  readonly flagged: boolean;
  /** Where the weight came from, when worth saying. */
  readonly note: string | null;
}

export const weightSourceLabel: Record<CapacityWeightSource, string> = {
  "reference-plan": "plan table",
  "published-session-multiplier": "published multiplier",
  "reported-absolute": "limit reported",
  "unknown-plan": "plan unknown · 1x",
};

export const planName = (plan: string | null, provider: string) =>
  plan === null
    ? "No plan reported"
    : accountPlanName(plan, provider === "codex" ? "openai" : provider);

/** Exclusions can contain server-authored explanations rather than plan identifiers. */
export const exclusionName = (label: string, provider: string) =>
  label === "Unverified plan" || label === "Unknown plan" ? label : planName(label, provider);

/** Unit sizing labels are not plans; reported and table candidates name a plan. */
export const candidateName = (
  candidate: NonNullable<CapacityForecastShortfall["candidate"]>,
  provider: string,
) => (candidate.source === "unit" ? candidate.label : planName(candidate.label, provider));

const forecastReasonLabels: Record<string, string> = {
  "invalid-input": "forecast inputs are invalid",
  "insufficient-history": "not enough completed weeks are available",
  "history-gap": "some hourly readings are missing",
  "partial-account-coverage": "some readings do not cover every account",
  "incomplete-current-week": "the current week is incomplete",
  "missing-account-reading": "an account has no current reading",
  "unknown-account-weight": "an account weight is unknown",
  "missing-reset-time": "an account reset time is unknown",
  "unhealthy-account": "an account is unavailable",
  "backtest-insufficient": "there is not enough held-out history to check the forecast",
  "backtest-not-better": "the seasonal forecast did not beat the seasonal naive baseline",
  "candidate-weight-unavailable": "no verified candidate account weight is available",
  "partial-exposure-estimate":
    "small unobserved intervals are estimated from comparable observed exposure",
  "censored-demand": "exhausted hours measure served use, so unmet demand is unknown",
  "rolling-expiry-unavailable": "the rolling window's expiry history is unavailable",
};

export const forecastReasons = (reasons: readonly string[]) =>
  reasons.map((reason) => forecastReasonLabels[reason] ?? reason.replaceAll("-", " "));

/** The plans in the latest snapshot, flagged where the weight is the unknown-plan 1x fallback. */
export function planChips(point: CapacityHistoryPoint | null): PlanChip[] {
  if (!point) return [];
  const groups = new Map<
    string,
    { accounts: number; flagged: boolean; sources: Set<CapacityWeightSource> }
  >();
  for (const plan of point.plans) {
    const last = plan.last;
    if (last === null || last.accountCount <= 0) continue;
    const name = planName(plan.plan, point.provider);
    const group = groups.get(name) ?? {
      accounts: 0,
      flagged: false,
      sources: new Set<CapacityWeightSource>(),
    };
    group.accounts += last.accountCount;
    group.flagged ||= last.unknownWeightCount > 0;
    for (const weight of last.weights) group.sources.add(weight.source);
    groups.set(name, group);
  }
  return [...groups].map(([plan, group]) => {
    const sources = [...group.sources];
    const note = group.flagged
      ? weightSourceLabel["unknown-plan"]
      : sources.length === 1 && sources[0] !== "reference-plan"
        ? weightSourceLabel[sources[0]!]
        : null;
    return { key: plan, plan, accounts: group.accounts, flagged: group.flagged, note };
  });
}

/** Merge only tooltip presentation; hourly capacity and per-plan source readings stay intact. */
export function tooltipPlanRows(point: CapacityHistoryPoint) {
  const raw = point.raw ?? point;
  const plans = isMeasuredCapacityPoint(point) ? point.plans : raw.plans;
  const rawByPlan = new Map(raw.plans.map((plan) => [plan.plan, plan.minimum]));
  const groups = new Map<
    string,
    {
      accounts: number;
      remaining: number;
      full: number;
      flagged: boolean;
      sources: Set<CapacityWeightSource>;
      raw: { remaining: number; full: number } | null;
      rawComplete: boolean;
    }
  >();
  for (const plan of plans) {
    if (plan.minimum.accountCount <= 0) continue;
    const name = planName(plan.plan, point.provider);
    const group = groups.get(name) ?? {
      accounts: 0,
      remaining: 0,
      full: 0,
      flagged: false,
      sources: new Set<CapacityWeightSource>(),
      raw: null,
      rawComplete: true,
    };
    group.accounts += plan.minimum.accountCount;
    group.remaining += plan.minimum.remaining;
    group.full += plan.minimum.full;
    group.flagged ||= plan.minimum.unknownWeightCount > 0;
    for (const weight of plan.minimum.weights) group.sources.add(weight.source);
    const quota = rawByPlan.get(plan.plan);
    if (quota)
      group.raw = {
        remaining: (group.raw?.remaining ?? 0) + quota.remaining,
        full: (group.raw?.full ?? 0) + quota.full,
      };
    if (quota === undefined) group.rawComplete = false;
    groups.set(name, group);
  }
  return [...groups].map(([plan, { sources, raw, rawComplete, ...group }]) => ({
    ...group,
    plan,
    sources: [...sources],
    raw: rawComplete ? raw : null,
  }));
}

const units = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

/** "4.2", "38", "1,240": one decimal under 10 units, whole numbers above. */
export const amount = (value: number) => (Math.abs(value) >= 10 ? whole : units).format(value);

/** "6h", "16.8h", "1.5d": gaps end at a reading time, not on the hour, so hours arrive fractional. */
export const duration = (hours: number) =>
  hours >= 48
    ? `${units.format(hours / 24)}d`
    : hours > 0 && hours < 0.05
      ? "<0.1h"
      : `${units.format(hours)}h`;

const pad = (value: number) => String(value).padStart(2, "0");
const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Capacity is stored in UTC hours, so its labels say UTC rather than shifting into local time. */
export const hourLabel = (at: number) => `${pad(new Date(at).getUTCHours())}:00`;
export const dayLabel = (at: number) =>
  `${weekday[new Date(at).getUTCDay()]} ${new Date(at).getUTCDate()}`;
export const dayLong = (at: number) => `${dayLabel(at)} ${month[new Date(at).getUTCMonth()]}`;
export const whenLabel = (at: number) => `${weekday[new Date(at).getUTCDay()]} ${hourLabel(at)}`;
