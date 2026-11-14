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
  formatShare,
  metricLabel,
  plural,
} from "./summary-format.ts";
import {
  cacheShare,
  dayTotal,
  delta,
  incident,
  pricing,
  stack,
  total,
  type Breakdown,
  type Metric,
  type RangeDays,
} from "./summary-model.ts";

export interface SummaryControls {
  readonly days: RangeDays;
  readonly by: Breakdown;
  readonly metric: Metric;
  readonly onDays: (days: RangeDays) => void;
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

function Header({ controls, updating }: { controls: SummaryControls; updating: boolean }) {
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
          value={controls.days}
          onChange={controls.onDays}
          options={[
            { id: 7, label: "7 days" },
            { id: 30, label: "30 days" },
            { id: 90, label: "90 days" },
          ]}
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
    </section>
  );
}

/** Only failures happening now earn an alert; a quiet hour says nothing at all. */
function Incident({ summary }: { summary: PoolUsageSummaryResult }) {
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
    </div>
  );
}

function Coverage({ summary }: { summary: PoolUsageSummaryResult }) {
  const sources = summary.coverage.sources;
  const live = sources.filter((source) => source.kind !== "import");
  const imported = sources.filter((source) => source.kind === "import");
  const firstOf = (list: typeof sources) =>
    list
      .map((source) => source.firstAt)
      .filter((at): at is string => at !== null)
      .sort()[0];
  const liveFrom = firstOf(live);
  const importFrom = firstOf(imported);
  const money = pricing(summary.daily);
  const gaps = summary.historyCoverage.gapDays.length;
  const pills = [
    live.length > 0 && (liveFrom ? `Live since ${formatDay(liveFrom)}` : "Live, no requests yet"),
    imported.length > 0 &&
      (importFrom
        ? `Imported from ${formatDay(importFrom)}${imported.every((source) => source.completion) ? ", complete" : ""}`
        : "Import has no records yet"),
    gaps > 0 && `${plural(gaps, "day", "days")} without records`,
  ].filter((pill): pill is string => typeof pill === "string");
  return (
    <div className="mb-6 grid gap-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-1.5">
        {pills.map((pill) => (
          <span key={pill} className="rounded-full border px-2 py-0.5">
            {pill}
          </span>
        ))}
      </div>
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

function Spark({ values }: { values: readonly (number | null)[] }) {
  const known = values.map((value) => value ?? 0);
  const max = Math.max(...known, 0);
  if (values.length < 2 || max === 0) return <div className="h-6" aria-hidden="true" />;
  const points = known
    .map((value, index) => `${(index / (values.length - 1)) * 100},${24 - (value / max) * 22}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
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
    <div className="grid min-w-0 content-start gap-1 rounded-lg border px-4 pt-3 pb-2">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <span className="truncate text-2xl font-semibold tracking-[-0.02em] tabular-nums">
        {props.value}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {change === null ? "no earlier range to compare" : `${change} vs previous`}
        {props.note ? ` · ${props.note}` : ""}
      </span>
      <span className="text-muted-foreground/70">
        <Spark values={props.spark} />
      </span>
    </div>
  );
}

function Kpis({ summary, metric }: { summary: PoolUsageSummaryResult; metric: Metric }) {
  const days = (m: Metric) => stack(summary.daily, "provider", m).days.map(dayTotal);
  const cost = total(summary.daily, "cost");
  const requests = total(summary.daily, "requests");
  const tokens = total(summary.daily, "tokens");
  const before = (m: Metric) => total(summary.previousDaily, m).value;
  const share = cacheShare(summary.daily);
  const dayCount = Math.max(1, stack(summary.daily, "provider", metric).days.length);
  const selected = total(summary.daily, metric).value;
  return (
    <div className="mb-6 grid grid-cols-4 gap-3 max-[720px]:grid-cols-2">
      <Kpi
        label="Est. cost"
        value={formatMetric("cost", cost.value)}
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
        value={formatMetric("tokens", tokens.value)}
        change={delta(tokens.value, before("tokens"))}
        note={share === null ? undefined : `${formatShare(share)} cache`}
        spark={days("tokens")}
      />
      <Kpi
        label={`${metricLabel[metric]} per day`}
        value={formatMetric(metric, selected === null ? null : selected / dayCount)}
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
      <Header controls={controls} updating={updating} />
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
          <Incident summary={summary.value} />
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
          />
          <SummaryForecasts summary={summary.value} metric={controls.metric} name={name} />
        </div>
      )}
      <CapacitySection
        result={currentCapacity(state?.capacity, view)}
        empty={view !== undefined && overviewAccounts(view).length === 0}
        providers={providers}
        accounts={capacityInputs(overviewAccounts(view)).map(accountWindows)}
        days={controls.days}
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
