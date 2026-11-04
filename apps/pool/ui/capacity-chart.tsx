import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { CapacityForecastPoint, CapacityHistoryPoint } from "../capacity-contract.ts";
import {
  amount,
  dayLabel,
  dayLong,
  dayMs,
  gaps,
  hourLabel,
  hourMs,
  isOut,
  outSpans,
  planName,
  segments,
  isMeasuredCapacityPoint,
  weightSourceLabel,
  type CapacityLine,
  type LineFacts,
} from "./capacity-model.ts";

interface Geometry {
  width: number;
  small: boolean;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  laneTop: number;
  laneHeight: number;
  axisY: number;
  min: number;
  max: number;
  x: (at: number) => number;
  y: (value: number) => number;
  at: (px: number) => number;
}

function geometry(
  width: number,
  from: number,
  to: number,
  full: number,
  low: number,
  lane: boolean,
  candidate: number | null,
): Geometry {
  const small = width < 520;
  const [left, right, top] = [40, 8, 22];
  const bottom = top + (small ? 164 : 200);
  const laneTop = bottom + 28;
  const laneHeight = 14;
  const axisY = (lane ? laneTop + laneHeight : bottom) + 16;
  const capacity = Math.max(full, 1e-9);
  const min =
    low < 0 ? (candidate ? -Math.ceil(-low / candidate) * candidate * 1.06 : low * 1.1) : 0;
  const max = capacity * 1.12;
  const span = Math.max(1, to - from);
  return {
    width,
    small,
    height: axisY + 22,
    left,
    right,
    top,
    bottom,
    laneTop,
    laneHeight,
    axisY,
    min,
    max,
    x: (at) => left + ((at - from) / span) * (width - left - right),
    y: (value) =>
      top + ((max - Math.max(min, Math.min(max, value))) / (max - min)) * (bottom - top),
    at: (px) => from + ((px - left) / (width - left - right)) * span,
  };
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(
      ([entry]) => entry && setWidth(Math.max(280, Math.round(entry.contentRect.width))),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

const linePath = (
  points: readonly { at: number; value: number }[],
  x: Geometry["x"],
  y: Geometry["y"],
) =>
  points
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${x(point.at + hourMs).toFixed(1)},${y(point.value).toFixed(1)}`,
    )
    .join(" ");

export function CapacityChart({
  line,
  from,
  to,
  now,
  color,
  facts,
  lab,
}: {
  line: CapacityLine;
  from: number;
  to: number;
  now: number;
  color: string;
  facts: LineFacts;
  lab: string;
}) {
  const { ref, width } = useWidth();
  const [hour, setHour] = useState<number | null>(null);
  const byHour = useMemo(
    () => new Map(line.points.map((point) => [point.hour, point])),
    [line.points],
  );
  const measuredPoints = useMemo(() => line.points.filter(isMeasuredCapacityPoint), [line.points]);
  const forecast =
    line.forecast?.status === "estimated" && line.forecast.points.length > 0 ? line.forecast : null;
  const forecastByHour = useMemo(
    () => new Map(forecast?.points.map((point) => [point.at, point]) ?? []),
    [forecast],
  );
  const full = Math.max(0, ...line.points.map((point) => point.minimum.full));
  const nominal = facts.latest?.last.full ?? full;
  const lowestProjection = Math.min(
    0,
    ...(forecast?.points.flatMap((point) => [point.low, point.median, point.busy]) ?? []),
  );
  const candidate = forecast?.ordinary?.candidate ?? forecast?.busy?.candidate ?? null;
  const ceiling = Math.max(
    full,
    ...(forecast?.points ?? []).flatMap((entry) => [
      entry.median,
      entry.low,
      entry.high,
      entry.busy,
    ]),
  );
  const end = forecast?.points.length ? forecast.points.at(-1)!.at + hourMs : to;
  const g = geometry(
    width,
    from,
    end,
    ceiling,
    lowestProjection,
    line.windowSeconds === 604_800,
    candidate?.capacity ?? null,
  );
  const unit = line.unit.label;
  const first = measuredPoints[0];
  const lastHour = Math.floor((end - 1) / hourMs) * hourMs;
  const clamp = (at: number) =>
    Math.max(Math.floor(from / hourMs) * hourMs, Math.min(lastHour, at));
  const point = hour === null ? undefined : byHour.get(hour);
  const projected = hour === null ? undefined : forecastByHour.get(hour);
  const tracked = first !== undefined && hour !== null && hour >= first.hour && hour < now;
  const tipWidth = Math.min(300, Math.max(220, width - 16));
  const tipX =
    hour === null ? 8 : Math.max(8, Math.min(g.x(hour + hourMs) + 14, width - tipWidth - 8));

  const select = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * g.width;
    if (px >= g.left) setHour(clamp(Math.floor(g.at(px) / hourMs) * hourMs));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? dayMs : hourMs;
    const current = hour ?? facts.latest?.hour ?? Math.floor(now / hourMs) * hourMs;
    const next =
      event.key === "ArrowLeft"
        ? current - step
        : event.key === "ArrowRight"
          ? current + step
          : event.key === "Home"
            ? Math.floor(from / hourMs) * hourMs
            : event.key === "End"
              ? lastHour
              : null;
    if (event.key === "Escape") setHour(null);
    if (next === null) return;
    event.preventDefault();
    setHour(clamp(next));
  };

  const y0 = g.y(0);
  const out = outSpans(measuredPoints);
  const missing = gaps(measuredPoints, now);
  const ticks: number[] = [];
  const pxPerDay = g.x(from + dayMs) - g.x(from);
  const every = pxPerDay >= 56 ? 1 : pxPerDay >= 28 ? 2 : pxPerDay >= 14 ? 4 : 7;
  for (let at = Math.ceil(from / dayMs) * dayMs, index = 0; at <= end; at += dayMs, index++)
    if (index % every === 0) ticks.push(at);
  const medianPath = forecast
    ? `M${g.x(now).toFixed(1)},${g.y(facts.latest?.last.remaining ?? forecast.points[0]!.median).toFixed(1)} ${linePath(
        forecast.points.map((point) => ({ at: point.at, value: point.median })),
        g.x,
        g.y,
      ).replace(/^M/, "L")}`
    : "";
  const busyPath = forecast
    ? `M${g.x(now).toFixed(1)},${g.y(facts.latest?.last.remaining ?? forecast.points[0]!.busy).toFixed(1)} ${linePath(
        forecast.points.map((point) => ({ at: point.at, value: point.busy })),
        g.x,
        g.y,
      ).replace(/^M/, "L")}`
    : "";
  const range = forecast
    ? [
        ...forecast.points.map(
          (point) => `${g.x(point.at + hourMs).toFixed(1)},${g.y(point.high).toFixed(1)}`,
        ),
        ...forecast.points
          .slice()
          .reverse()
          .map((point) => `${g.x(point.at + hourMs).toFixed(1)},${g.y(point.low).toFixed(1)}`),
      ].join(" ")
    : "";
  const weekly = line.windowSeconds === 604_800;
  const refills = weekly ? line.refills.filter((event) => event.at >= from && event.at <= end) : [];
  const refillMax = Math.max(1, ...refills.map((event) => event.amount));
  const description = hour === null ? "" : describe(hour, point, projected, unit, tracked);

  return (
    <div
      ref={ref}
      className="relative mt-3.5 rounded-[4px] outline-offset-4 touch-pan-y"
      tabIndex={0}
      role="group"
      aria-label={`${lab} ${line.label.toLowerCase()} capacity. Measured history; ${forecast ? "72-hour seasonal forecast" : line.forecast?.status === "learning" ? "forecast learning" : "forecast unavailable"}. Use arrow keys to read hours; Shift moves a day; Escape closes details.`}
      aria-describedby={
        hour === null ? undefined : `capacity-tooltip-${line.key.replace(/[^a-z0-9]/gi, "-")}`
      }
      onKeyDown={onKey}
      onFocus={() =>
        setHour((current) => current ?? facts.latest?.hour ?? Math.floor(now / hourMs) * hourMs)
      }
    >
      <svg
        viewBox={`0 0 ${g.width} ${g.height}`}
        height={g.height}
        className="block w-full overflow-visible text-[11px] tabular-nums"
        aria-hidden="true"
        onPointerMove={(event) => {
          if (event.pointerType === "mouse") select(event);
        }}
        onPointerDown={select}
      >
        <defs>
          <pattern
            id={`shortfall-${line.key.replace(/[^a-z0-9]/gi, "-")}`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill="var(--destructive)" opacity="0.08" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="6"
              stroke="var(--destructive)"
              strokeWidth="1.3"
              opacity="0.55"
            />
          </pattern>
        </defs>
        {forecast && (
          <rect
            x={g.x(now)}
            y={g.top}
            width={Math.max(0, g.x(end) - g.x(now))}
            height={g.bottom - g.top}
            fill="var(--muted)"
            opacity="0.45"
          />
        )}
        {g.min < 0 && (
          <rect
            x={g.x(now)}
            y={y0}
            width={Math.max(0, g.x(end) - g.x(now))}
            height={g.bottom - y0}
            fill="var(--destructive)"
            opacity="0.035"
          />
        )}
        <line
          x1={g.left}
          x2={g.width - g.right}
          y1={g.y(ceiling / 2)}
          y2={g.y(ceiling / 2)}
          stroke="var(--border)"
        />
        <text
          x={g.left - 6}
          y={g.y(ceiling / 2) + 4}
          textAnchor="end"
          fill="var(--muted-foreground)"
        >
          {amount(ceiling / 2)}
        </text>
        <line
          x1={g.left}
          x2={g.width - g.right}
          y1={y0}
          y2={y0}
          stroke="var(--muted-foreground)"
          strokeOpacity={0.6}
        />
        <text x={g.left - 6} y={y0 + 4} textAnchor="end" fill="var(--foreground)" fontWeight={500}>
          0
        </text>
        {candidate &&
          g.min < 0 &&
          (() => {
            let lastLabel = y0;
            const totalRules = Math.floor(-g.min / candidate.capacity);
            const ruleStep = Math.max(1, Math.ceil(totalRules / 12));
            return Array.from(
              { length: Math.min(12, totalRules) },
              (_, index) => (index + 1) * ruleStep,
            )
              .filter((count) => count <= totalRules)
              .map((count) => {
                const value = -count * candidate.capacity;
                const labelAt = g.y(value);
                const showLabel = labelAt - lastLabel >= 13;
                if (showLabel) lastLabel = labelAt;
                return (
                  <g key={count}>
                    <line
                      x1={g.x(now)}
                      x2={g.width - g.right}
                      y1={g.y(value)}
                      y2={g.y(value)}
                      stroke="var(--destructive)"
                      strokeOpacity={0.4}
                      strokeDasharray="1 3"
                    />
                    {showLabel && (
                      <>
                        <text
                          x={g.width - g.right - 4}
                          y={g.y(value) - 3}
                          textAnchor="end"
                          fill="var(--destructive)"
                        >
                          {g.small ? `+${count}` : `${count} more ${candidate.label}`}
                        </text>
                        <text
                          x={g.left - 6}
                          y={g.y(value) + 4}
                          textAnchor="end"
                          fill="var(--muted-foreground)"
                        >
                          {amount(value)}
                        </text>
                      </>
                    )}
                  </g>
                );
              });
          })()}
        {first && first.hour > from + hourMs && (
          <text
            x={(g.x(from) + g.x(first.hour)) / 2}
            y={g.top + (g.bottom - g.top) / 3}
            textAnchor="middle"
            fill="var(--muted-foreground)"
          >
            Not tracked yet
          </text>
        )}
        {missing.map((span) => (
          <g key={`gap-${span.from}`}>
            <rect
              x={g.x(span.from)}
              y={g.top}
              width={Math.max(2, g.x(span.to) - g.x(span.from))}
              height={y0 - g.top}
              fill="var(--accent)"
              stroke="var(--input)"
              strokeWidth={0.5}
            />
            {g.x(span.to) - g.x(span.from) > 60 && (
              <text
                x={(g.x(span.from) + g.x(span.to)) / 2}
                y={g.top + 12}
                textAnchor="middle"
                fill="var(--muted-foreground)"
              >
                no readings
              </text>
            )}
          </g>
        ))}
        {out.map((span) => (
          <g key={`out-${span.from}`}>
            <rect
              x={g.x(span.from)}
              y={g.top}
              width={Math.max(2, g.x(span.to) - g.x(span.from))}
              height={y0 - g.top}
              fill="var(--destructive)"
              opacity={0.13}
            />
            <rect
              x={g.x(span.from)}
              y={y0 - 2}
              width={Math.max(2, g.x(span.to) - g.x(span.from))}
              height={3}
              fill="var(--destructive)"
            />
          </g>
        ))}
        {nominal > 0 && (
          <>
            <line
              x1={g.left}
              x2={g.width - g.right}
              y1={g.y(nominal)}
              y2={g.y(nominal)}
              stroke="var(--muted-foreground)"
              strokeOpacity={0.8}
              strokeDasharray="1 3"
            />
            <text x={g.left} y={g.y(nominal) - 6} fill="var(--muted-foreground)">
              {g.small
                ? `Nominal ${amount(nominal)} · reference`
                : `Nominal ${amount(nominal)} ${unit} · every window fresh · reference, not available`}
            </text>
          </>
        )}
        {line.windowSeconds === 18_000 && (
          <UsableLine points={line.points} forecast={forecast?.points ?? []} g={g} />
        )}
        {segments(measuredPoints).map((run) => {
          const points = run.map(
            (entry) =>
              `${g.x(entry.hour + hourMs).toFixed(1)},${g.y(entry.minimum.remaining).toFixed(1)}`,
          );
          const start = g.x(run[0]!.hour).toFixed(1);
          const startY = g.y(run[0]!.minimum.remaining).toFixed(1);
          const all = [`${start},${startY}`, ...points].join(" ");
          return (
            <g key={`run-${run[0]!.hour}`}>
              <polygon
                points={`${start},${y0} ${all} ${g.x(run.at(-1)!.hour + hourMs).toFixed(1)},${y0}`}
                fill={color}
                opacity={0.1}
              />
              <polyline
                points={all}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            </g>
          );
        })}
        {weekly &&
          facts.weeklyLows.map((low) => (
            <g key={`weekly-low-${low.hour}`}>
              <circle
                cx={g.x(low.hour + hourMs)}
                cy={g.y(low.minimum.remaining)}
                r={3.5}
                fill="var(--background)"
                stroke="var(--foreground)"
                strokeWidth={1.5}
              >
                <title>{`${dayLong(low.hour)} weekly low ${amount(low.minimum.remaining)} ${unit}`}</title>
              </circle>
            </g>
          ))}
        {forecast && (
          <g>
            <polygon
              points={`${g.x(now)},${g.y(facts.latest?.last.remaining ?? forecast.points[0]?.median ?? 0)} ${range}`}
              fill={color}
              opacity={0.16}
            />
            {forecast.points.map(
              (entry) =>
                (entry.low < 0 || entry.median < 0 || entry.busy < 0) && (
                  <rect
                    key={`shortfall-${entry.at}`}
                    x={g.x(entry.at)}
                    y={y0}
                    width={Math.max(1, g.x(entry.at + hourMs) - g.x(entry.at))}
                    height={Math.max(1, g.y(Math.min(0, entry.low, entry.median, entry.busy)) - y0)}
                    fill={`url(#shortfall-${line.key.replace(/[^a-z0-9]/gi, "-")})`}
                  />
                ),
            )}
            <path
              d={medianPath}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeDasharray="5 4"
              strokeLinejoin="round"
            />
            <path
              d={busyPath}
              fill="none"
              stroke={color}
              strokeOpacity={0.55}
              strokeWidth={1.3}
              strokeDasharray="2 3"
              strokeLinejoin="round"
            />
            <text x={g.x(now) + 6} y={g.top + 12} fill="var(--foreground)">
              {g.small
                ? "Projected"
                : `Projected · ${line.forecast!.history.completedWeeks} completed weeks`}
            </text>
          </g>
        )}
        {weekly && <RefillLane events={refills} max={refillMax} g={g} unit={unit} />}
        {forecast?.runsOutAt !== null &&
          forecast?.runsOutAt !== undefined &&
          forecast.runsOutAt >= now && (
            <g>
              <circle
                cx={g.x(forecast.runsOutAt + hourMs)}
                cy={y0}
                r={4.5}
                fill="var(--destructive)"
                stroke="var(--background)"
                strokeWidth={2}
              >
                <title>Likely out</title>
              </circle>
              <text x={g.x(forecast.runsOutAt + hourMs) + 7} y={y0 - 7} fill="var(--destructive)">
                Likely out
              </text>
            </g>
          )}
        <line
          x1={g.x(now)}
          x2={g.x(now)}
          y1={g.top - 8}
          y2={weekly ? g.laneTop + g.laneHeight : g.bottom}
          stroke="var(--foreground)"
          strokeOpacity={0.55}
        />
        <text
          x={g.x(now) - 4}
          y={g.top - 10}
          textAnchor="end"
          fill="var(--foreground)"
          fontWeight={500}
        >
          Now
        </text>
        {ticks.map((at) => (
          <g key={at}>
            <line x1={g.x(at)} x2={g.x(at)} y1={g.axisY} y2={g.axisY + 3} stroke="var(--input)" />
            <text x={g.x(at) + 3} y={g.axisY + 16} fill="var(--muted-foreground)">
              {every >= 4 ? dayLong(at).replace(/^\w+ /, "") : dayLabel(at)}
            </text>
          </g>
        ))}
        {hour !== null && (
          <g>
            <line
              x1={g.x(hour + hourMs)}
              x2={g.x(hour + hourMs)}
              y1={g.top - 4}
              y2={g.axisY}
              stroke="var(--foreground)"
              strokeOpacity={0.35}
            />
            {point && isMeasuredCapacityPoint(point) && (
              <circle
                cx={g.x(hour + hourMs)}
                cy={g.y(point.minimum.remaining)}
                r={4.5}
                fill={color}
                stroke="var(--background)"
                strokeWidth={2}
              />
            )}
            {projected && (
              <circle
                cx={g.x(hour + hourMs)}
                cy={g.y(projected.median)}
                r={4.5}
                fill={color}
                stroke="var(--background)"
                strokeWidth={2}
              />
            )}
          </g>
        )}
      </svg>
      {hour !== null && (
        <div
          id={`capacity-tooltip-${line.key.replace(/[^a-z0-9]/gi, "-")}`}
          role="tooltip"
          className="pointer-events-none absolute top-6 z-[5] w-max min-w-[220px] max-w-[300px] rounded-lg border border-border bg-background px-3 py-2.5 text-xs shadow-[var(--tooltip-shadow)]"
          style={{ left: tipX, maxWidth: `min(300px, calc(100vw - 2rem))` }}
        >
          <Tip hour={hour} point={point} projected={projected} line={line} tracked={tracked} />
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {description}
      </p>
    </div>
  );
}

function UsableLine({
  points,
  forecast,
  g,
}: {
  points: readonly CapacityHistoryPoint[];
  forecast: readonly CapacityForecastPoint[];
  g: Geometry;
}) {
  const all = [
    ...points.map((point) => ({ at: point.hour, value: point.usable?.remaining ?? null })),
    ...forecast.map((point) => ({ at: point.at, value: point.usable ?? null })),
  ];
  const paths: string[] = [];
  let path = "",
    previous: (typeof all)[number] | undefined;
  const flush = () => {
    if (path) paths.push(path);
    path = "";
    previous = undefined;
  };
  for (const point of all) {
    if (point.value === null || (previous && point.at - previous.at > hourMs)) flush();
    if (point.value === null) continue;
    path += path
      ? ` V${g.y(point.value).toFixed(1)} H${g.x(point.at + hourMs).toFixed(1)}`
      : `M${g.x(point.at).toFixed(1)},${g.y(point.value).toFixed(1)} H${g.x(point.at + hourMs).toFixed(1)}`;
    previous = point;
  }
  flush();
  return (
    <>
      {paths.map((entry, index) => (
        <path
          key={index}
          d={entry}
          fill="none"
          stroke="var(--foreground)"
          strokeOpacity={0.52}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      ))}
    </>
  );
}

function RefillLane({
  events,
  max,
  g,
  unit,
}: {
  events: CapacityLine["refills"];
  max: number;
  g: Geometry;
  unit: string;
}) {
  const base = g.laneTop + g.laneHeight;
  return (
    <g>
      <text x={g.left} y={g.laneTop - 5} fill="var(--muted-foreground)">
        Refills · restored amount, not capacity left
      </text>
      <line x1={g.left} x2={g.width - g.right} y1={base} y2={base} stroke="var(--border)" />
      {events.map((event) => {
        const x = g.x(event.at);
        const height = Math.max(3, (g.laneHeight * event.amount) / max);
        const expected = event.kind === "expected";
        const banked = event.kind === "banked";
        const amountLabel = `${event.amountIsLowerBound ? "≥" : ""}${amount(event.amount)} ${unit}`;
        return (
          <g key={`${event.at}-${event.kind}`}>
            {expected && (
              <line
                x1={x}
                x2={x}
                y1={g.top + 18}
                y2={base}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.55}
                strokeDasharray="1 3"
              />
            )}
            <rect
              x={x - 3.5}
              y={base - height}
              width={7}
              height={height}
              rx={1}
              fill={expected ? "var(--background)" : "var(--muted-foreground)"}
              fillOpacity={expected ? 0 : 0.18}
              stroke="var(--muted-foreground)"
              strokeOpacity={expected ? 0.75 : 0.55}
              strokeDasharray={expected ? "2 1.5" : undefined}
              strokeWidth={1.2}
            />
            {banked && (
              <circle
                cx={x}
                cy={base - height}
                r={3}
                fill="var(--background)"
                stroke="var(--muted-foreground)"
                strokeWidth={1.2}
              />
            )}
            {(expected || banked || event.amountIsLowerBound) && (
              <text x={x + 5} y={base - height - 2} fill="var(--muted-foreground)">
                {amountLabel}
              </text>
            )}
            <title>{`${expected ? "Expected refill" : banked ? "Banked reset used, recorded" : "Observed refill"}${event.amountIsLowerBound ? " at least" : ""}: ${amountLabel}`}</title>
          </g>
        );
      })}
    </g>
  );
}

function describe(
  hour: number,
  point: CapacityHistoryPoint | undefined,
  projected: CapacityForecastPoint | undefined,
  unit: string,
  tracked: boolean,
) {
  const when = `${dayLong(hour)} ${hourLabel(hour)} UTC`;
  if (projected)
    return `${when}: projected median ${amount(projected.median)} ${unit}, likely range ${amount(projected.low)} to ${amount(projected.high)}, busy path ${amount(projected.busy)}.${projected.usable === undefined || projected.usable === null ? "" : ` Potential five-hour allowance under the weekly limit ${amount(projected.usable)}.`}`;
  if (!tracked) return `${when}: not tracked yet.`;
  if (!point) return `${when}: no readings.`;
  const requests =
    point.requests === null || point.requests === undefined
      ? "request count unavailable"
      : `${point.requests.toLocaleString()} requests this hour`;
  const coverage =
    point.coverage === null || point.coverage === undefined
      ? "coverage unavailable"
      : `${Math.round(point.coverage * 100)}% request capture coverage`;
  const source =
    point.sourceAt === null || point.sourceAt === undefined
      ? "source time unavailable"
      : `source read ${new Date(point.sourceAt).toISOString().replace("T", " ").slice(0, 16)} UTC`;
  const gateKnown = isMeasuredCapacityPoint(point);
  const raw = point.raw ?? { minimum: point.minimum, last: point.last, plans: point.plans };
  const remaining =
    point.windowSeconds === 18_000 && !gateKnown ? raw.minimum.remaining : point.minimum.remaining;
  const measure =
    point.windowSeconds === 18_000
      ? gateKnown
        ? `usable five-hour remaining after the weekly gate: ${amount(remaining)} of ${amount(point.minimum.full)} ${unit}`
        : `reported five-hour quota: ${amount(remaining)} of ${amount(raw.minimum.full)} ${unit}; weekly gate unavailable`
      : `lowest ${amount(remaining)} of ${amount(point.minimum.full)} ${unit} left`;
  const rawText =
    point.windowSeconds === 18_000 && gateKnown
      ? ` Provider-reported raw five-hour quota at the low: ${amount(raw.minimum.remaining)} of ${amount(raw.minimum.full)} ${unit}.`
      : "";
  const usable = point.usable
    ? ` Potential five-hour allowance under the weekly limit ${amount(point.usable.remaining)} of ${amount(point.usable.full)} ${unit}.`
    : "";
  return `${when}: ${measure}${isOut(point) ? ", all accounts out of usable allowance" : ""}.${rawText}${usable} ${requests}; ${coverage}; ${source}.`;
}

function Tip({
  hour,
  point,
  projected,
  line,
  tracked,
}: {
  hour: number;
  point: CapacityHistoryPoint | undefined;
  projected: CapacityForecastPoint | undefined;
  line: CapacityLine;
  tracked: boolean;
}) {
  const unit = line.unit.label;
  const head = (
    <div className="text-muted-foreground">
      {dayLong(hour)} · {hourLabel(hour)}–{hourLabel(hour + hourMs)} UTC · {line.label}
    </div>
  );
  if (projected)
    return (
      <>
        {head}
        <div className="mt-1 grid gap-0.5 text-[13px]">
          <span>
            Projected median:{" "}
            <b className="font-medium text-foreground tabular-nums">
              {amount(projected.median)} {unit}
            </b>
          </span>
          <span>
            Likely range: {amount(projected.low)} to {amount(projected.high)} {unit}
          </span>
          <span>
            Busy path (p90 demand): {amount(projected.busy)} {unit}
          </span>
          {projected.usable !== undefined && projected.usable !== null && (
            <span>
              Potential 5-hour allowance under weekly limit: {amount(projected.usable)} {unit}
            </span>
          )}
        </div>
        <div className="mt-1 border-t border-border pt-1 text-muted-foreground">
          Seasonal forecast · banked resets stay unspent
        </div>
      </>
    );
  if (!point)
    return (
      <>
        {head}
        <div className="mt-0.5 text-[13px]">
          {tracked ? "No readings this hour" : "Not tracked yet"}
        </div>
        {tracked && (
          <div className="text-muted-foreground">Shown as a gap. Nothing is filled in.</div>
        )}
      </>
    );
  const gateKnown = isMeasuredCapacityPoint(point);
  const raw = point.raw ?? { minimum: point.minimum, last: point.last, plans: point.plans };
  const planValues = gateKnown ? point.plans : raw.plans;
  const plans = planValues.filter((plan) => plan.minimum.accountCount > 0);
  const rawByPlan = new Map(raw.plans.map((plan) => [JSON.stringify(plan.plan), plan]));
  const coverage = point.coverage == null ? "Unavailable" : `${Math.round(point.coverage * 100)}%`;
  const sourceAt =
    point.sourceAt == null
      ? "Unavailable"
      : new Date(point.sourceAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const usable =
    line.windowSeconds === 18_000
      ? point.usable
        ? `${amount(point.usable.remaining)} of ${amount(point.usable.full)} ${unit}`
        : "Unavailable"
      : null;
  return (
    <>
      {head}
      <div className="mt-0.5 mb-1.5 text-[13px]">
        {isOut(point) && (
          <span className="text-destructive">All accounts out of usable allowance · </span>
        )}
        <b className="text-[15px] font-semibold tracking-[-0.015em] tabular-nums">
          {amount(gateKnown ? point.minimum.remaining : raw.minimum.remaining)}
        </b>{" "}
        of {amount(gateKnown ? point.minimum.full : raw.minimum.full)} {unit} left at the hour's low
        {line.windowSeconds === 18_000 && (
          <span className="block text-muted-foreground">
            {gateKnown
              ? "Usable after the same accounts' weekly limits."
              : "Provider quota only; weekly gate is unavailable for this reading."}
          </span>
        )}
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {plans.map((plan) => {
            const flagged = plan.minimum.unknownWeightCount > 0;
            const sources = [
              ...new Set(plan.minimum.weights.map((weight) => weightSourceLabel[weight.source])),
            ].join(", ");
            return (
              <tr key={planName(plan.plan)}>
                <td className="py-0.5 align-top break-words [overflow-wrap:anywhere]">
                  {planName(plan.plan)} ×{plan.minimum.accountCount}
                  <span
                    className={`block text-[11px] ${flagged ? "text-warning" : "text-muted-foreground"}`}
                  >
                    {flagged ? "Flagged. " : ""}
                    {sources}
                  </span>
                  {line.windowSeconds === 18_000 && rawByPlan.has(JSON.stringify(plan.plan)) && (
                    <span className="block text-[11px] text-muted-foreground">
                      Provider quota:{" "}
                      {amount(rawByPlan.get(JSON.stringify(plan.plan))!.minimum.remaining)} /{" "}
                      {amount(rawByPlan.get(JSON.stringify(plan.plan))!.minimum.full)}
                    </span>
                  )}
                </td>
                <td className="py-0.5 pl-2.5 text-right align-top whitespace-nowrap tabular-nums">
                  {amount(plan.minimum.remaining)} / {amount(plan.minimum.full)}
                </td>
              </tr>
            );
          })}
          <tr className="font-medium">
            <td className="border-t border-border pt-1">Total</td>
            <td className="border-t border-border pt-1 text-right tabular-nums">
              {amount(gateKnown ? point.minimum.remaining : raw.minimum.remaining)} /{" "}
              {amount(gateKnown ? point.minimum.full : raw.minimum.full)}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="mt-1.5 grid gap-0.5 border-t border-border pt-1.5 text-muted-foreground">
        <span>
          {line.windowSeconds === 18_000
            ? gateKnown
              ? "Latest usable this hour:"
              : "Latest provider quota this hour:"
            : "Latest this hour:"}{" "}
          <b className="font-medium text-foreground tabular-nums">
            {amount(gateKnown ? point.last.remaining : raw.last.remaining)}
          </b>{" "}
          of {amount(gateKnown ? point.last.full : raw.last.full)} {unit}
        </span>
        <span>
          {point.minimum.accountCount} {point.minimum.accountCount === 1 ? "account" : "accounts"}
          {point.minimum.unknownWeightCount > 0
            ? ` · ${point.minimum.unknownWeightCount} with flagged weights`
            : ""}
        </span>
        <span>
          Requests:{" "}
          {point.requests == null ? "unavailable" : `${point.requests.toLocaleString()} this hour`}{" "}
          · capture coverage {coverage}
        </span>
        {usable !== null && <span>Usable five-hour allowance: {usable}</span>}
        <span>Source: {sourceAt}</span>
      </div>
    </>
  );
}
