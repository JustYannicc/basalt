import type { CapacityAggregate, CapacityHistoryPoint, CapacityWeightSource, PoolCapacityHistory } from "../capacity-contract.ts";

// Measured capacity, one line per provider window and unit. Empty hours stay gaps; nothing here
// projects, interpolates or invents refills. A window a lab doesn't report simply has no line.

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
}

export interface CapacityLab {
  readonly provider: string;
  /** Longest window first, so Weekly reads before 5-hour. */
  readonly lines: readonly CapacityLine[];
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
    const key = JSON.stringify([point.windowSeconds, point.mode, point.unit.id]);
    const lines = labs.get(point.provider) ?? new Map<string, CapacityHistoryPoint[]>();
    labs.set(point.provider, lines);
    lines.set(key, [...(lines.get(key) ?? []), point]);
  }
  return [...labs].map(([provider, lines]) => {
    const built = [...lines].map(([key, points]) => {
      const first = points[0]!;
      const label = windowLabel(first.windowSeconds) + (first.mode ? ` · ${first.mode}` : "");
      return { key, windowSeconds: first.windowSeconds, mode: first.mode, unit: first.unit, label, points: [...points].sort((a, b) => a.hour - b.hour) };
    });
    // Two units on one window would otherwise share a label.
    const named = built.map((line) =>
      built.some((other) => other !== line && other.label === line.label) ? { ...line, label: `${line.label} · ${line.unit.label}` } : line,
    );
    return { provider, lines: named.sort((a, b) => b.windowSeconds - a.windowSeconds || a.label.localeCompare(b.label)) };
  });
}

export const share = (aggregate: Pick<CapacityAggregate, "remaining" | "full">) =>
  aggregate.full > 0 ? Math.max(0, Math.min(1, aggregate.remaining / aggregate.full)) : null;

export const isOut = (point: CapacityHistoryPoint) =>
  point.minimum.full > 0 && point.minimum.remaining <= point.minimum.full * outShare;

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
    if (last && last.to === point.hour) out[out.length - 1] = { from: last.from, to: point.hour + hourMs };
    else out.push({ from: point.hour, to: point.hour + hourMs });
  }
  return out;
}

export interface LineFacts {
  readonly latest: CapacityHistoryPoint | null;
  readonly lowest: CapacityHistoryPoint | null;
  readonly outHours: number;
  readonly episodes: number;
  readonly longestHours: number;
  readonly gapHours: number;
  readonly measuredHours: number;
}

export function lineFacts(line: CapacityLine, to: number): LineFacts {
  const spans = outSpans(line.points);
  const lengths = spans.map((span) => (span.to - span.from) / hourMs);
  let lowest: CapacityHistoryPoint | null = null;
  for (const point of line.points) {
    const value = share(point.minimum);
    const best = lowest ? share(lowest.minimum) : null;
    if (value !== null && (best === null || value < best)) lowest = point;
  }
  return {
    latest: line.points.at(-1) ?? null,
    lowest,
    outHours: lengths.reduce((sum, hours) => sum + hours, 0),
    episodes: spans.length,
    longestHours: Math.max(0, ...lengths),
    gapHours: gaps(line.points, to).reduce((sum, span) => sum + (span.to - span.from) / hourMs, 0),
    measuredHours: line.points.length,
  };
}

/** Which window the panel opens on: the one with less left at its latest reading. */
export function pressing(lab: CapacityLab): { readonly key: string; readonly text: string | null } {
  const ranked = lab.lines
    .map((line) => ({ line, left: line.points.length ? share(line.points.at(-1)!.last) : null }))
    .filter((entry): entry is { line: CapacityLine; left: number } => entry.left !== null)
    .sort((a, b) => a.left - b.left);
  const first = ranked[0];
  if (!first) return { key: lab.lines[0]?.key ?? "", text: null };
  if (lab.lines.length < 2 || ranked.length < 2) return { key: first.line.key, text: null };
  const other = ranked[1]!;
  const now = (left: number) => (left <= outShare ? "out now" : `${Math.round(left * 100)}% left now`);
  return { key: first.line.key, text: `${first.line.label} is more pressing: ${now(first.left)}; ${other.line.label.toLowerCase()} ${now(other.left)}` };
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
  const first = points[0];
  if (!first) return [];
  const days = new Map<number, { lowest: CapacityAggregate | null; out: number; measured: number }>();
  for (let day = Math.floor(first.hour / dayMs) * dayMs; day < to; day += dayMs) days.set(day, { lowest: null, out: 0, measured: 0 });
  for (const point of points) {
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
      return { day, lowest: row.lowest, outHours: row.out, missingHours: Math.max(0, (end - start) / hourMs - row.measured) };
    })
    .reverse();
}

export interface PlanChip {
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

export const planName = (plan: string | null) => plan ?? "No plan reported";

/** The plans in the latest snapshot, flagged where the weight is the unknown-plan 1x fallback. */
export function planChips(point: CapacityHistoryPoint | null): PlanChip[] {
  if (!point) return [];
  return point.plans
    .filter((plan) => plan.last !== null && plan.last.accountCount > 0)
    .map((plan) => {
      const last = plan.last!;
      const sources = [...new Set(last.weights.map((weight) => weight.source))];
      const flagged = last.unknownWeightCount > 0;
      const note = flagged
        ? weightSourceLabel["unknown-plan"]
        : sources.length === 1 && sources[0] !== "reference-plan"
          ? weightSourceLabel[sources[0]!]
          : null;
      return { plan: planName(plan.plan), accounts: last.accountCount, flagged, note };
    });
}

const units = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

/** "4.2", "38", "1,240": one decimal under 10 units, whole numbers above. */
export const amount = (value: number) => (Math.abs(value) >= 10 ? whole : units).format(value);

const pad = (value: number) => String(value).padStart(2, "0");
const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Capacity is stored in UTC hours, so its labels say UTC rather than shifting into local time. */
export const hourLabel = (at: number) => `${pad(new Date(at).getUTCHours())}:00`;
export const dayLabel = (at: number) => `${weekday[new Date(at).getUTCDay()]} ${new Date(at).getUTCDate()}`;
export const dayLong = (at: number) => `${dayLabel(at)} ${month[new Date(at).getUTCMonth()]}`;
export const whenLabel = (at: number) => `${weekday[new Date(at).getUTCDay()]} ${hourLabel(at)}`;
