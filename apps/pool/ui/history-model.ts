import type { SeriesCoverage, SeriesGroup } from "../usage-series-contract.ts";
import type { Result } from "../control.ts";
import type { SeriesFetch, SeriesQuery } from "./series-model.ts";
import { readSeries } from "./series-model.ts";

const utcDay = 86_400_000;
const maxSeriesRange = 400 * utcDay;
const emptyHistoryStart = "1970-01-01T00:00:00.000Z";

export interface HistoryDateFilter {
  readonly from?: string;
  readonly to?: string;
}

export interface HistoryBounds {
  readonly from: string;
  /** Exclusive end, matching the retained-history reader. */
  readonly to: string;
}

export interface HistoryCursor {
  readonly timestamp: string;
  readonly id: string;
}

export interface PublicHistoryQuery extends HistoryBounds {
  readonly after?: HistoryCursor;
}

/** Public history intentionally carries metadata only; request and response content never crosses. */
export interface PublicHistoryRecord {
  readonly id: string;
  readonly timestamp: string;
  readonly person: string | null;
  readonly request_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly endpoint: string | null;
  readonly api_type: string | null;
  readonly service_tier: string | null;
  readonly input_tokens: string | null;
  readonly output_tokens: string | null;
  readonly cache_read_tokens: string | null;
  readonly cache_write_tokens: string | null;
  readonly reasoning_tokens: string | null;
  readonly total_tokens: string | null;
  readonly token_quality: "complete" | "legacy" | "unclassified" | "inconsistent";
  readonly latency_ms: string | null;
  readonly failed: boolean;
  readonly status_code: number | null;
  readonly cost: string | null;
  readonly currency: string | null;
  readonly cost_basis: "home-charge" | "historical-api-price" | "unpriced";
  readonly attribution: "charge-snapshot" | "key-at-capture" | "import-owner" | "unknown";
}

export interface PublicHistoryPage {
  readonly records: readonly PublicHistoryRecord[];
  readonly next: HistoryCursor | null;
}

export type PublicHistoryReader = (input: PublicHistoryQuery) => Promise<Result<PublicHistoryPage>>;

function dateStart(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return null;
  return new Date(time).toISOString();
}

function dateEnd(value: string): string | null {
  const start = dateStart(value);
  if (start === null) return null;
  return new Date(Date.parse(start) + utcDay).toISOString();
}

/** Empty dates mean all retained history; either boundary may be set on its own. */
export function historyDateBounds(
  filter: HistoryDateFilter,
  firstAt: string | null,
  now: number,
): HistoryBounds | null {
  const to = filter.to === undefined ? new Date(now).toISOString() : dateEnd(filter.to);
  // A range ending before the first retained request is empty, not an invalid date range.
  const from =
    filter.from === undefined
      ? firstAt !== null && to !== null && Date.parse(firstAt) < Date.parse(to)
        ? // Public pages order PostgreSQL timestamps, which round the source's nanoseconds.
          // Include the rounding interval so another row at that timestamp cannot be excluded.
          new Date(Date.parse(firstAt) - 1).toISOString()
        : emptyHistoryStart
      : dateStart(filter.from);
  if (from === null || to === null || Date.parse(from) >= Date.parse(to)) return null;
  return { from, to };
}

/** The series contract bounds each read to 400 days; adjacent reads are half-open. */
export function historyWindows(from: string, to: string): HistoryBounds[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const nanos = (value: string, millis: number) =>
    BigInt(millis) * 1_000_000n +
    BigInt((/\.(\d+)Z$/.exec(value)?.[1] ?? "").slice(3).padEnd(6, "0"));
  const first = nanos(from, start);
  const last = nanos(to, end);
  if (first >= last) return [];

  const windows: HistoryBounds[] = [];
  let lower = from;
  for (let cursor = first; cursor < last;) {
    const limit = cursor + BigInt(maxSeriesRange) * 1_000_000n;
    // Intermediate boundaries use whole milliseconds; the final endpoint remains exact.
    const next = limit >= last ? last : (limit / 1_000_000n) * 1_000_000n;
    // Keep the retained reader's sub-millisecond endpoints. Converting them to Date loses rows.
    const upper = next === last ? to : new Date(Number(next / 1_000_000n)).toISOString();
    windows.push({ from: lower, to: upper });
    lower = upper;
    cursor = next;
  }
  return windows;
}

export interface MonthCount {
  readonly month: string;
  readonly requests: number;
}

export interface HistorySeriesRead {
  readonly groups: readonly SeriesGroup[];
  readonly coverage?: SeriesCoverage;
  readonly asOf: string | null;
  readonly changed: boolean;
  readonly partial: boolean;
}

function groupId(group: SeriesGroup): string {
  return JSON.stringify(Object.entries(group.key).sort(([a], [b]) => a.localeCompare(b)));
}

const earliest = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a < b ? a : b;
const latest = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a > b ? a : b;

function mergeCoverage(into: SeriesCoverage, next: SeriesCoverage): SeriesCoverage {
  const sources = new Map(into.sources.map((source) => [source.source, source]));
  for (const source of next.sources) {
    const known = sources.get(source.source);
    sources.set(
      source.source,
      known
        ? {
            ...known,
            firstAt: earliest(known.firstAt, source.firstAt),
            lastAt: latest(known.lastAt, source.lastAt),
            backfillComplete: known.backfillComplete ?? source.backfillComplete,
            sweep: known.sweep ?? source.sweep,
          }
        : source,
    );
  }
  const sum = (a: number, b: number) => {
    const value = a + b;
    if (!Number.isSafeInteger(value))
      throw new Error("Usage coverage count exceeds the safe range");
    return value;
  };
  return {
    ...into,
    sources: [...sources.values()].sort((a, b) => a.source.localeCompare(b.source)),
    firstAt: earliest(into.firstAt, next.firstAt),
    lastAt: latest(into.lastAt, next.lastAt),
    capturedThrough: latest(into.capturedThrough, next.capturedThrough),
    mapping: {
      ...into.mapping,
      proof:
        into.mapping.proof === "proven" && next.mapping.proof === "proven"
          ? "proven"
          : "unavailable",
      mapped: sum(into.mapping.mapped, next.mapping.mapped),
      unmapped: sum(into.mapping.unmapped, next.mapping.unmapped),
      otherAccounts: sum(into.mapping.otherAccounts, next.mapping.otherAccounts),
    },
    pricing: {
      ...into.pricing,
      homeCharge: sum(into.pricing.homeCharge, next.pricing.homeCharge),
      importedApiPrice: sum(into.pricing.importedApiPrice, next.pricing.importedApiPrice),
      unpriced: sum(into.pricing.unpriced, next.pricing.unpriced),
      missing: sum(into.pricing.missing, next.pricing.missing),
      missingSnapshot: sum(into.pricing.missingSnapshot, next.pricing.missingSnapshot),
      missingVersion: sum(into.pricing.missingVersion, next.pricing.missingVersion),
    },
  };
}

/** Reads every bounded window and cursor page without dropping retained imports between windows. */
export async function readHistorySeries(
  fetch: SeriesFetch,
  bounds: HistoryBounds,
  maxPages = 10,
): Promise<Result<HistorySeriesRead>> {
  const groups = new Map<string, SeriesGroup>();
  let asOf: string | null = null;
  let coverage: SeriesCoverage | undefined;
  let changed = false;
  let partial = false;

  for (const window of historyWindows(bounds.from, bounds.to)) {
    const query: SeriesQuery = {
      ...window,
      bucket: "day",
      by: ["person", "provider", "model", "source", "attribution"],
    };
    const result = await readSeries(fetch, query, maxPages);
    if (!result.ok) return result;
    const page = result.value;
    // Different ranges naturally have different ingestion watermarks.
    asOf = latest(asOf, page.asOf);
    coverage = coverage === undefined ? page.coverage : mergeCoverage(coverage, page.coverage);
    changed ||= page.asOfChanged;
    partial ||= page.truncated;

    for (const group of page.groups) {
      const key = groupId(group);
      const existing = groups.get(key);
      groups.set(
        key,
        existing ? { key: existing.key, buckets: [...existing.buckets, ...group.buckets] } : group,
      );
    }
  }

  for (const [key, group] of groups)
    groups.set(key, {
      ...group,
      buckets: [...group.buckets].sort((a, b) => a.at.localeCompare(b.at)),
    });

  return {
    ok: true,
    value: {
      groups: [...groups.values()],
      ...(coverage === undefined ? {} : { coverage }),
      asOf,
      changed,
      partial,
    },
  };
}

/** Series buckets already group every retained source; month totals keep imports in that rollup. */
export function monthCounts(groups: readonly SeriesGroup[]): MonthCount[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const bucket of group.buckets) {
      const month = bucket.at.slice(0, 7);
      const next = (counts.get(month) ?? 0) + bucket.requests;
      if (!Number.isSafeInteger(next))
        throw new Error("Monthly request count exceeds the safe range");
      counts.set(month, next);
    }
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, requests]) => ({ month, requests }));
}
