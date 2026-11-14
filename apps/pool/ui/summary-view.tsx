import { Button, Tabs, TabsList, TabsTrigger } from "apps/ui";
import type { PoolView, Provider } from "../contract.ts";
import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";
import type { PoolApi } from "./api.ts";
import { providerName } from "./accounts.tsx";
import { CapacitySection } from "./capacity-view.tsx";
import { capacityInputs } from "./account-view.ts";
import { accountWindows } from "./account-limits.ts";
import { overviewAccounts } from "./overview-accounts.ts";
import { bankedResetLine } from "./overview-attention.ts";
import { currentCapacity } from "./overview-snapshot.ts";
import { SummaryBreakdown } from "./summary-breakdown.tsx";
import { SummaryChart } from "./summary-chart.tsx";
import type { SummaryState } from "./summary-data.ts";
import { SummaryForecasts } from "./summary-forecast.tsx";
import {
  formatCount,
  formatDay,
  formatDelta,
  formatMetric,
  formatMonth,
  formatShare,
  metricLabel,
  plural,
} from "./summary-format.ts";
import {
  cacheShare,
  calendarDays,
  dayTotal,
  delta,
  incident,
  knownRuns,
  maxRangeDays,
  pricing,
  rangeKey,
  sinceOption,
  stack,
  summaryRange,
  total,
  type Breakdown,
  type Metric,
  type RangeChoice,
  type SummaryBounds,
} from "./summary-model.ts";

export interface SummaryControls {
  readonly range: RangeChoice;
  readonly by: Breakdown;
  readonly metric: Metric;
  readonly onRange: (range: RangeChoice) => void;
  readonly onBy: (by: Breakdown) => void;
  readonly onMetric: (metric: Metric) => void;
}

function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Tabs
        value={String(value)}
        onValueChange={(next) => {
          const option = options.find((entry) => String(entry.id) === next);
          if (option) onChange(option.id);
        }}
      >
        <TabsList aria-label={label}>
          {options.map((option) => (
            <TabsTrigger key={option.id} value={String(option.id)}>
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

/**
 * A member's range: the fixed windows the member route accepts, never the since-start range. A
 * demoted manager's since-start choice shows as the 7 days the member read falls back to.
 */
export function FixedRange({
  range,
  onRange,
}: {
  range: RangeChoice;
  onRange: (range: RangeChoice) => void;
}) {
  return (
    <Choice
      label="Range"
      value={range.kind === "days" ? String(range.days) : "7"}
      onChange={(key) => onRange({ kind: "days", days: Number(key) as 7 | 30 | 90 })}
      options={[
        { id: "7", label: "7 days" },
        { id: "30", label: "30 days" },
        { id: "90", label: "90 days" },
      ]}
    />
  );
}

/** The since-start label names the first retained month, or says the window is capped. */
function sinceLabel(bounds: SummaryBounds, first: string) {
  return bounds.bounded ? `Last ${maxRangeDays} days` : `Since ${formatMonth(first)}`;
}

function Header({
  controls,
  updating,
  since,
  bounds,
}: {
  controls: SummaryControls;
  updating: boolean;
  since: ReturnType<typeof sinceOption>;
  bounds: SummaryBounds | undefined;
}) {
  const fixed: RangeChoice[] = [7, 30, 90].map((days) => ({ kind: "days", days }) as RangeChoice);
  // A selected since-start window stays offered while a newer answer is on its way.
  const sinceChoice =
    since?.choice ?? (controls.range.kind === "since" ? controls.range : undefined);
  const ranges = sinceChoice ? [...fixed, sinceChoice] : fixed;
  const label = (choice: RangeChoice) =>
    choice.kind === "days"
      ? `${choice.days} days`
      : sinceLabel(summaryRange(choice, Date.now()), choice.first);
  return (
    <section className="grid gap-4 pt-8 pb-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">How much are we using?</h1>
        {updating && (
          <span role="status" className="text-xs text-muted-foreground">
            Updating…
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <Choice
          label="Range"
          value={rangeKey(controls.range)}
          onChange={(key) => {
            const next = ranges.find((choice) => rangeKey(choice) === key);
            if (next) controls.onRange(next);
          }}
          options={ranges.map((choice) => ({ id: rangeKey(choice), label: label(choice) }))}
        />
        <Choice
          label="Show"
          value={controls.metric}
          onChange={controls.onMetric}
          options={[
            { id: "cost", label: "Est. cost" },
            { id: "tokens", label: "Tokens" },
            { id: "requests", label: "Requests" },
          ]}
        />
        <Choice
          label="By"
          value={controls.by}
          onChange={controls.onBy}
          options={[
            { id: "provider", label: "Lab" },
            { id: "model", label: "Model" },
          ]}
        />
      </div>
      {controls.range.kind === "since" && bounds && (
        <p className="text-xs text-muted-foreground text-pretty">
          {bounds.bounded
            ? `From ${formatDay(bounds.from)}, the oldest day a ${maxRangeDays}-day range reaches. Retained requests start earlier, on ${formatDay(controls.range.first)}.`
            : `From ${formatDay(bounds.from)}, the day of the first retained request.`}
        </p>
      )}
    </section>
  );
}

/** Only failures happening now earn an alert; a quiet hour says nothing at all. */
function Incident({
  summary,
  onHistory,
}: {
  summary: PoolUsageSummaryResult;
  onHistory: (search: Record<string, string>) => void;
}) {
  const now = incident(summary.incidents);
  if (now.state !== "failing") return null;
  const top = now.failures
    .slice(0, 3)
    .map((failure) => `${formatCount(failure.count)} × ${failure.status ?? "no status"}`)
    .join(", ");
  return (
    <div
      role="alert"
      className="mb-5 flex flex-wrap items-baseline gap-x-2 rounded-md border border-destructive/40 px-4 py-3 text-sm"
    >
      <span className="font-medium text-destructive">
        {formatCount(now.failed)} of {plural(now.requests, "request", "requests")} failed in the
        last hour
      </span>
      <span className="text-muted-foreground">
        {top}
        {now.partial ? " · some of the hour couldn't be read" : ""}
      </span>
      <Button
        size="sm"
        variant="link"
        className="ml-auto"
        onClick={() =>
          onHistory({
            status: "failed",
            from: summary.incidents.from.slice(0, 10),
            to: summary.incidents.to.slice(0, 10),
          })
        }
      >
        See failed requests
      </Button>
    </div>
  );
}

function Coverage({ summary }: { summary: PoolUsageSummaryResult }) {
  const sources = summary.coverage.sources;
  const live = sources.filter((source) => source.kind !== "import");
  const imported = sources.filter((source) => source.kind === "import");
  const liveFrom = live
    .map((source) => source.firstAt)
    .filter((at): at is string => at !== null)
    .sort()[0];
  const money = pricing(summary.daily);
  const history = summary.historyCoverage;
  const gaps = history.gapDays.length;
  const pills = [
    live.length > 0 && (liveFrom ? `Live since ${formatDay(liveFrom)}` : "Live, no requests yet"),
    // A completion certificate covers only its frozen interval; an import without one is unproven.
    ...imported.map((source) =>
      source.completion
        ? `Import complete ${formatDay(source.completion.frozenFrom)} to ${formatDay(source.completion.frozenTo)}`
        : source.firstAt
          ? `Imported from ${formatDay(source.firstAt)}, completeness not certified`
          : "Import has no records yet",
    ),
    gaps > 0 &&
      `Capture unproven on ${plural(gaps, "day", "days")} of ${formatCount(gaps + history.knownDays.length)}, ${formatDay(history.from)} to ${formatDay(history.to)}`,
  ].filter((pill): pill is string => typeof pill === "string");
  return (
    <div className="mb-6 grid gap-2 text-xs text-muted-foreground">
      <ul aria-label="Coverage" className="flex flex-wrap gap-1.5">
        {pills.map((pill) => (
          <li key={pill} className="rounded-full border px-2 py-0.5">
            {pill}
          </li>
        ))}
      </ul>
      <p className="max-w-[44rem] text-pretty">
        Counts every request through this pool. Cost is what the same tokens would cost at current
        official API prices
        {money.unpriced + money.countsOnly > 0
          ? `; ${plural(money.unpriced + money.countsOnly, "request has", "requests have")} no price and count only as requests`
          : ""}
        .{summary.partial ? " Part of this range couldn't be read; totals cover what was." : ""}
      </p>
    </div>
  );
}

/** Known days only: an unknown day breaks the line, it never dips to zero. */
function Spark({ values }: { values: readonly (number | null)[] }) {
  const runs = knownRuns(values);
  const max = Math.max(0, ...runs.flat().map((point) => point.value));
  if (values.length < 2 || max === 0 || runs.every((run) => run.length < 2))
    return <div className="h-6" aria-hidden="true" />;
  const x = (index: number) => (index / (values.length - 1)) * 100;
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full" aria-hidden="true">
      {runs
        .filter((run) => run.length > 1)
        .map((run) => (
          <polyline
            key={run[0]!.index}
            points={run
              .map((point) => `${x(point.index)},${24 - (point.value / max) * 22}`)
              .join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
    </svg>
  );
}

function Kpi(props: {
  label: string;
  value: string;
  change: number | null;
  note?: string | undefined;
  spark: readonly (number | null)[];
}) {
  const change = formatDelta(props.change);
  return (
    <section
      aria-label={props.label}
      className="grid min-w-0 content-start gap-1 rounded-lg border px-4 pt-3 pb-2"
    >
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <span className="truncate text-2xl font-semibold tracking-[-0.02em] tabular-nums">
        {props.value}
      </span>
      <span
        className="truncate text-xs text-muted-foreground"
        title={props.note ? `${change ?? ""} ${props.note}`.trim() : undefined}
      >
        {change === null ? "no earlier range to compare" : `${change} vs previous`}
        {props.note ? ` · ${props.note}` : ""}
      </span>
      <span className="text-muted-foreground/70">
        <Spark values={props.spark} />
      </span>
    </section>
  );
}

function Kpis({ summary, metric }: { summary: PoolUsageSummaryResult; metric: Metric }) {
  // The selected calendar, not just the days that had usage, so a quiet week averages honestly.
  const calendar = {
    from: summary.from,
    to: summary.to,
    knownDays: summary.historyCoverage.knownDays,
  };
  const days = (m: Metric) => stack(summary.daily, "provider", m, calendar).days.map(dayTotal);
  const cost = total(summary.daily, "cost");
  const requests = total(summary.daily, "requests");
  const tokens = total(summary.daily, "tokens");
  const before = (m: Metric) => total(summary.previousDaily, m).value;
  const share = cacheShare(summary.daily);
  const dayCount = Math.max(1, calendarDays(summary.from, summary.to).length);
  const chosen = total(summary.daily, metric);
  const selected = chosen.value;
  return (
    <div className="mb-6 grid grid-cols-4 gap-3 max-[720px]:grid-cols-2">
      <Kpi
        label="Est. cost"
        value={`${cost.missing > 0 && cost.value !== null ? "≥ " : ""}${formatMetric("cost", cost.value)}`}
        change={delta(cost.value, before("cost"))}
        note={cost.missing > 0 ? `${formatCount(cost.missing)} unpriced` : undefined}
        spark={days("cost")}
      />
      <Kpi
        label="Requests"
        value={formatMetric("requests", requests.value)}
        change={delta(requests.value, before("requests"))}
        spark={days("requests")}
      />
      <Kpi
        label="Tokens"
        value={`${tokens.missing > 0 && tokens.value !== null ? "≥ " : ""}${formatMetric("tokens", tokens.value)}`}
        change={delta(tokens.value, before("tokens"))}
        note={
          [
            tokens.missing > 0
              ? `known for all but ${plural(tokens.missing, "request", "requests")}`
              : null,
            share.share === null
              ? null
              : `${formatShare(share.share)} cache${share.partial ? " of fully counted days" : ""}`,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        }
        spark={days("tokens")}
      />
      <Kpi
        label={`${metricLabel[metric]} per day`}
        value={`${chosen.missing > 0 && selected !== null ? "≥ " : ""}${formatMetric(metric, selected === null ? null : selected / dayCount)}`}
        change={delta(selected, before(metric))}
        spark={days(metric)}
      />
    </div>
  );
}

export function SummaryOverview({
  api,
  state,
  shownBy,
  updating,
  controls,
  view,
  providers,
  now,
  onRetry,
  onHistory,
}: {
  api: PoolApi;
  state: SummaryState | undefined;
  /** The breakdown `state` holds; a newly chosen one shows once its own answer arrives. */
  shownBy: Breakdown;
  updating: boolean;
  controls: SummaryControls;
  view: PoolView | undefined;
  providers: readonly Provider[];
  now: number;
  onRetry: () => void;
  /** Opens the host's History page with these filters. */
  onHistory: (search: Record<string, string>) => void;
}) {
  const summary = state?.summary;
  const name = (provider: string | null) =>
    provider === null ? "Unknown lab" : providerName(providers, provider);
  // Banked resets are counted per lab and kind, never as one pooled number. Spending stays in Accounts.
  const resets = view
    ? [...new Set(overviewAccounts(view).map((account) => account.provider))].flatMap((lab) => {
        const line = bankedResetLine(
          { ...view, accounts: view.accounts.filter((account) => account.provider === lab) },
          now,
        );
        return line ? [{ lab, text: line.text }] : [];
      })
    : [];
  return (
    <>
      <Header
        controls={controls}
        updating={updating}
        since={summary?.ok ? sinceOption(summary.value.retainedFirstAt, now) : null}
        bounds={state?.bounds}
      />
      {summary === undefined ? (
        <div aria-hidden="true" className="grid gap-3">
          <div className="h-28 animate-pulse rounded-lg bg-accent" />
          <div className="h-60 animate-pulse rounded-lg bg-accent" />
        </div>
      ) : !summary.ok ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3 text-sm">
          <span className="text-destructive">{summary.message}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <div data-summary-as-of={summary.value.asOf ?? ""}>
          <Incident summary={summary.value} onHistory={onHistory} />
          <Coverage summary={summary.value} />
          <Kpis summary={summary.value} metric={controls.metric} />
          <SummaryChart summary={summary.value} by={shownBy} metric={controls.metric} name={name} />
          <SummaryBreakdown
            api={api}
            summary={summary.value}
            by={shownBy}
            metric={controls.metric}
            view={view}
            name={name}
            onHistory={onHistory}
          />
          <SummaryForecasts summary={summary.value} metric={controls.metric} name={name} />
        </div>
      )}
      <CapacitySection
        result={currentCapacity(state?.capacity, view)}
        empty={view !== undefined && overviewAccounts(view).length === 0}
        providers={providers}
        accounts={capacityInputs(overviewAccounts(view)).map(accountWindows)}
        days={state?.bounds?.days ?? (controls.range.kind === "days" ? controls.range.days : 7)}
        coherent={state?.coherent === true}
        onRetry={onRetry}
      />
      {resets.length > 0 && (
        <ul aria-label="Banked resets" className="grid gap-1 pt-3 text-sm text-muted-foreground">
          {resets.map((reset) => (
            <li key={reset.lab} className="text-pretty">
              <span className="font-medium text-foreground">{name(reset.lab)}</span> banked:{" "}
              {reset.text}
            </li>
          ))}
          <li className="text-xs">Spend them from Accounts.</li>
        </ul>
      )}
    </>
  );
}
