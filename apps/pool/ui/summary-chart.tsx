import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";
import { labColor } from "./lab.tsx";
import {
  calendarDay,
  formatDay,
  formatMetric,
  formatWeekday,
  metricLabel,
} from "./summary-format.ts";
import { dayTotal, forecastFor, stack, type Breakdown, type Metric } from "./summary-model.ts";

const height = 160;

/** A model takes its lab's ink, lighter for each further model of the same lab. */
function inks(summary: PoolUsageSummaryResult, by: Breakdown, keys: readonly (string | null)[]) {
  if (by === "provider") return keys.map((key) => labColor(key));
  const groups = summary.models?.groups ?? summary.daily;
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const provider = groups.find((group) => group.model === key)?.provider ?? null;
    const index = seen.get(provider ?? "") ?? 0;
    seen.set(provider ?? "", index + 1);
    return `color-mix(in srgb, ${labColor(provider)} ${Math.max(35, 100 - index * 22)}%, var(--background))`;
  });
}

export function SummaryChart({
  summary,
  by,
  metric,
  name,
}: {
  summary: PoolUsageSummaryResult;
  by: Breakdown;
  metric: Metric;
  name: (provider: string | null) => string;
}) {
  const groups = by === "model" ? (summary.models?.groups ?? []) : summary.daily;
  const modelsMissing = by === "model" && summary.models?.status !== "available";
  const { keys, days } = stack(groups, by, metric, {
    from: summary.from,
    to: summary.to,
    knownDays: summary.historyCoverage.knownDays,
  });
  const colors = inks(summary, by, keys);
  const forecast = forecastFor(summary.forecasts, null, metric);
  const last = days.at(-1)?.day;
  // Only future days; today's actual stays a bar and is never replaced by a forecast.
  const ahead =
    forecast?.status === "available"
      ? forecast.daily
          .filter((day) => last === undefined || calendarDay(day.day) > last)
          .slice(0, 7)
      : [];
  const columns = days.length + ahead.length;
  const max = Math.max(
    1e-9,
    ...days.map((day) => dayTotal(day) ?? 0),
    ...ahead.map((day) => day.high ?? day.median),
  );
  const width = Math.max(1, columns) * 10;
  const y = (value: number) => height - (value / max) * height;
  const label = `${metricLabel[metric]} per day by ${by === "model" ? "model" : "lab"}`;
  return (
    <section aria-labelledby="usage-chart-heading" className="mb-8 grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="usage-chart-heading" className="text-base font-semibold tracking-[-0.015em]">
          {label}
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          up to {formatMetric(metric, max)} a day
        </span>
      </div>
      {modelsMissing ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-sm text-muted-foreground">
          {summary.models?.reason ?? "Models aren't available for this range."}
        </p>
      ) : days.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-sm text-muted-foreground">
          No requests in this range.
        </p>
      ) : (
        <>
          <svg
            role="img"
            aria-label={`${label}, ${days.length} days${ahead.length ? `, then a ${ahead.length}-day forecast` : ""}`}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="h-40 w-full"
          >
            {days.map((day, column) => {
              let top = height;
              return (
                <g key={day.day} opacity={day.partial ? 0.6 : 1}>
                  <title>{`${formatWeekday(day.day)} ${formatDay(day.day)}: ${formatMetric(metric, dayTotal(day))}${day.partial ? " so far" : ""}`}</title>
                  {day.values.map((value, index) => {
                    if (!value) return null;
                    const h = height - y(value);
                    top -= h;
                    return (
                      <rect
                        key={index}
                        x={column * 10 + 1.5}
                        y={top}
                        width={7}
                        height={h}
                        fill={colors[index]}
                      />
                    );
                  })}
                </g>
              );
            })}
            {ahead.map((day, offset) => {
              const x = (days.length + offset) * 10 + 1.5;
              return (
                <g key={day.day}>
                  <title>{`${formatWeekday(day.day)} ${formatDay(day.day)}: about ${formatMetric(metric, day.median)}${day.low !== null && day.high !== null ? `, 80% between ${formatMetric(metric, day.low)} and ${formatMetric(metric, day.high)}` : ""}`}</title>
                  {day.low !== null && day.high !== null && (
                    <rect
                      x={x}
                      y={y(day.high)}
                      width={7}
                      height={Math.max(0.5, y(day.low) - y(day.high))}
                      fill="currentColor"
                      className="text-muted-foreground/15"
                    />
                  )}
                  <line
                    x1={x}
                    x2={x + 7}
                    y1={y(day.median)}
                    y2={y(day.median)}
                    stroke="currentColor"
                    strokeDasharray="2 1.5"
                    vectorEffect="non-scaling-stroke"
                    className="text-muted-foreground"
                  />
                </g>
              );
            })}
          </svg>
          <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>{formatDay(days[0]!.day)}</span>
            {ahead.length > 0 && <span>forecast to {formatDay(ahead.at(-1)!.day)}</span>}
            {ahead.length === 0 && <span>{formatDay(days.at(-1)!.day)}</span>}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {keys.map((key, index) => (
              <li key={key ?? "none"} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-[3px]"
                  style={{ background: colors[index] }}
                />
                {by === "provider" ? name(key) : (key ?? "Unknown model")}
              </li>
            ))}
            {ahead.some((day) => day.low !== null) && (
              <li className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-[3px] bg-muted-foreground/20"
                />
                80% forecast range
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}
