import { Badge } from "apps/ui";
import type { UsageForecast, UsageProjection } from "../usage-forecast-contract.ts";
import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";
import {
  formatDay,
  formatMetric,
  formatMonth,
  formatShare,
  metricLabel,
  plural,
} from "./summary-format.ts";
import { forecastFor, heat, type Metric } from "./summary-model.ts";

// Every number here is the producer's: median, range, confidence and misses. A null bound is shown
// as no range, never as a band drawn from elapsed time.

const unavailable: Record<Extract<UsageForecast, { status: "unavailable" }>["reason"], string> = {
  "insufficient-history": "Not enough full weeks of history yet",
  "insufficient-use": "Too little use to forecast",
  "invalid-input": "This range can't be forecast",
};

function Projection({
  label,
  projection,
  metric,
}: {
  label: string;
  projection: UsageProjection;
  metric: Metric;
}) {
  const range =
    projection.low !== null && projection.high !== null
      ? `${formatMetric(metric, projection.low)}–${formatMetric(metric, projection.high)}`
      : null;
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">
        {projection.median === null ? "Unknown" : `~${formatMetric(metric, projection.median)}`}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {[
          range,
          projection.actual === null ? null : `${formatMetric(metric, projection.actual)} so far`,
        ]
          .filter(Boolean)
          .join(" · ") || "no range"}
      </span>
    </div>
  );
}

function Misses({ forecast, metric }: { forecast: UsageForecast; metric: Metric }) {
  if (forecast.status !== "available" || forecast.misses.length === 0) return null;
  const max = Math.max(...forecast.misses.flatMap((miss) => [miss.actual, miss.predicted]), 1e-9);
  const shares = forecast.misses.flatMap((miss) =>
    miss.share === null ? [] : [Math.abs(miss.share)],
  );
  return (
    <div className="grid gap-1">
      <div className="flex h-8 items-end gap-1" aria-hidden="true">
        {forecast.misses.map((miss) => (
          <span
            key={miss.week}
            title={`Week of ${formatDay(miss.week)}: ${formatMetric(metric, miss.actual)}, forecast ${formatMetric(metric, miss.predicted)}`}
            className="w-2.5 rounded-t-[2px] bg-muted-foreground/40"
            style={{ height: `${Math.max(4, (miss.actual / max) * 100)}%` }}
          />
        ))}
      </div>
      {shares.length > 0 && (
        <span className="text-xs text-muted-foreground">
          Off by {formatShare(shares.reduce((a, b) => a + b, 0) / shares.length)} on average over{" "}
          {plural(shares.length, "held-out week", "held-out weeks")}
        </span>
      )}
    </div>
  );
}

function ForecastRow({
  title,
  forecast,
  metric,
}: {
  title: string;
  forecast: UsageForecast | undefined;
  metric: Metric;
}) {
  return (
    <li className="grid grid-cols-[10rem_minmax(0,1fr)] items-start gap-4 border-t px-3 py-3 first:border-t-0 max-[720px]:grid-cols-1">
      <div className="grid justify-items-start gap-1">
        <span className="text-sm font-medium">{title}</span>
        {forecast?.status === "available" && (
          <Badge className="text-muted-foreground">{forecast.confidence} confidence</Badge>
        )}
      </div>
      {forecast === undefined ? (
        <span className="text-sm text-muted-foreground">No forecast for this lab.</span>
      ) : forecast.status === "unavailable" ? (
        <span className="text-sm text-muted-foreground">
          {unavailable[forecast.reason]}
          {forecast.reason === "insufficient-history"
            ? ` (${plural(forecast.comparableWeeks, "full week", "full weeks")} so far)`
            : ""}
          .
        </span>
      ) : (
        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-4 max-[540px]:grid-cols-2">
          <Projection label="This week" projection={forecast.thisWeek} metric={metric} />
          <Projection label="Next week" projection={forecast.nextWeek} metric={metric} />
          <Misses forecast={forecast} metric={metric} />
        </div>
      )}
    </li>
  );
}

function Month({ summary, metric }: { summary: PoolUsageSummaryResult; metric: Metric }) {
  const forecast = forecastFor(summary.forecasts, null, metric);
  if (forecast?.status !== "available") return null;
  const month = forecast.month;
  const name = formatMonth(month.from);
  const top = month.high ?? month.median;
  return (
    <div className="grid gap-2 rounded-lg border px-4 py-3">
      <span className="text-xs text-muted-foreground">
        {name}, {metricLabel[metric].toLowerCase()}
      </span>
      <span className="text-2xl font-semibold tracking-[-0.02em] tabular-nums">
        {month.median === null ? "Unknown" : `~${formatMetric(metric, month.median)}`}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {month.low !== null && month.high !== null
          ? `80% between ${formatMetric(metric, month.low)} and ${formatMetric(metric, month.high)}`
          : "no range"}
      </span>
      {month.actual !== null && top !== null && top > 0 && (
        <div className="grid gap-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-accent">
            <div
              className="h-full rounded-full bg-foreground/70"
              style={{ width: `${Math.min(100, (month.actual / top) * 100)}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatMetric(metric, month.actual)} so far, through {formatDay(month.through)}
          </span>
        </div>
      )}
    </div>
  );
}

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Heatmap({ summary }: { summary: PoolUsageSummaryResult }) {
  const map = summary.heatmap;
  const read = heat(map);
  const values = weekdays.flatMap((_, day) =>
    Array.from({ length: 24 }, (__, hour) => read(day, hour) ?? 0),
  );
  const max = Math.max(...values, 1e-9);
  return (
    <section aria-labelledby="heatmap-heading" className="grid gap-2">
      <h3 id="heatmap-heading" className="text-sm font-semibold">
        When we use it
      </h3>
      <p className="text-xs text-muted-foreground">
        Average tokens per hour, {formatDay(map.from)} to {formatDay(map.to)}, Zurich time.
      </p>
      {map.status === "unavailable" ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
          {map.reason ?? "No hourly records for this period."}
        </p>
      ) : (
        <div className="grid grid-cols-[2.25rem_repeat(24,minmax(0,1fr))] gap-[2px] text-[10px] text-muted-foreground">
          {weekdays.map((label, day) => (
            <div key={label} className="contents">
              <span className="self-center">{label}</span>
              {Array.from({ length: 24 }, (_, hour) => {
                const value = read(day, hour);
                return (
                  <span
                    key={hour}
                    title={`${label} ${hour}:00: ${value === null ? "no records" : `${formatMetric("tokens", value)} tokens an hour`}`}
                    className={`aspect-square rounded-[2px] ${value === null ? "border border-dashed" : "bg-foreground"}`}
                    style={value === null ? undefined : { opacity: 0.08 + (value / max) * 0.82 }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function SummaryForecasts({
  summary,
  metric,
  name,
}: {
  summary: PoolUsageSummaryResult;
  metric: Metric;
  name: (provider: string | null) => string;
}) {
  const labs = summary.forecasts.series.filter((series) => series.provider !== null);
  const method = forecastFor(summary.forecasts, null, metric);
  return (
    <section aria-labelledby="forecast-heading" className="mb-4 grid gap-5">
      <h2 id="forecast-heading" className="text-base font-semibold tracking-[-0.015em]">
        Where it's heading
      </h2>
      <ul className="grid rounded-lg border">
        <ForecastRow title="All labs" forecast={method} metric={metric} />
        {labs.map((series) => (
          <ForecastRow
            key={series.provider}
            title={name(series.provider)}
            forecast={forecastFor(summary.forecasts, series.provider, metric)}
            metric={metric}
          />
        ))}
      </ul>
      {method?.status === "available" && (
        <p className="text-xs text-muted-foreground text-pretty">
          {method.method}. The range covers 80% of held-out weeks
          {method.coverage.excludedRequests > 0
            ? `; ${plural(method.coverage.excludedRequests, "request", "requests")} without this metric are left out`
            : ""}
          .
        </p>
      )}
      <div className="grid grid-cols-[minmax(0,18rem)_minmax(0,1fr)] gap-5 max-[720px]:grid-cols-1">
        <Month summary={summary} metric={metric} />
        <Heatmap summary={summary} />
      </div>
    </section>
  );
}
