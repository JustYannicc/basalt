import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { CapacityHistoryPoint } from "../capacity-contract.ts";
import {
  amount, dayLabel, dayLong, dayMs, gaps, hourLabel, hourMs, isOut, outSpans, planName, segments, weightSourceLabel,
  type CapacityLine, type LineFacts,
} from "./capacity-model.ts";

// One window's measured capacity: the hourly low as a line, gaps left blank, red where every account
// was out, and a dotted nominal full line for reference. Hover or arrow keys read any hour, including
// each plan's contribution to that hour's low.

interface Geometry {
  readonly width: number;
  readonly small: boolean;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly x: (at: number) => number;
  readonly y: (value: number) => number;
  readonly at: (px: number) => number;
}

function geometry(width: number, from: number, to: number, ceiling: number): Geometry {
  const small = width < 520;
  const [left, right, top] = [40, 8, 22];
  const bottom = top + (small ? 164 : 200);
  const max = Math.max(ceiling, 1e-9) * 1.12;
  const span = Math.max(1, to - from);
  return {
    width, small, height: bottom + 22, left, right, top, bottom,
    x: (at) => left + ((at - from) / span) * (width - left - right),
    y: (value) => top + ((max - Math.max(0, Math.min(max, value))) / max) * (bottom - top),
    at: (px) => from + ((px - left) / (width - left - right)) * span,
  };
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function CapacityChart({ line, from, to, color, facts, lab }: {
  line: CapacityLine; from: number; to: number; color: string; facts: LineFacts; lab: string;
}) {
  const { ref, width } = useWidth();
  const [hour, setHour] = useState<number | null>(null);
  const byHour = useMemo(() => new Map(line.points.map((point) => [point.hour, point])), [line.points]);
  const ceiling = Math.max(0, ...line.points.map((point) => point.minimum.full));
  const g = geometry(width, from, to, ceiling);
  const unit = line.unit.label;
  const first = line.points[0];
  const lastHour = Math.floor((to - 1) / hourMs) * hourMs;
  const clamp = (at: number) => Math.max(Math.floor(from / hourMs) * hourMs, Math.min(lastHour, at));

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * g.width;
    setHour(px < g.left ? null : clamp(Math.floor(g.at(px) / hourMs) * hourMs));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? dayMs : hourMs;
    const current = hour ?? facts.latest?.hour ?? lastHour;
    const next =
      event.key === "ArrowLeft" ? current - step
        : event.key === "ArrowRight" ? current + step
          : event.key === "Home" ? (first?.hour ?? current)
            : event.key === "End" ? (facts.latest?.hour ?? current)
              : null;
    if (event.key === "Escape") setHour(null);
    if (next === null) return;
    event.preventDefault();
    setHour(clamp(next));
  };

  const fullPath = segments(line.points)
    .map((run) => run.map((point, index) => `${index ? "L" : "M"}${g.x(point.hour).toFixed(1)},${g.y(point.minimum.full).toFixed(1)} H${g.x(point.hour + hourMs).toFixed(1)}`).join(" "))
    .join(" ");
  const y0 = g.y(0);
  const pxPerDay = g.x(from + dayMs) - g.x(from);
  const every = pxPerDay >= 56 ? 1 : pxPerDay >= 28 ? 2 : pxPerDay >= 14 ? 4 : 7;
  const ticks: number[] = [];
  for (let at = Math.ceil(from / dayMs) * dayMs, index = 0; at <= to; at += dayMs, index++) if (index % every === 0) ticks.push(at);
  const point = hour === null ? undefined : byHour.get(hour);
  const tipLeft = hour === null ? 0 : g.x(hour + hourMs) * (1 / g.width) * 100;

  return (
    <div
      ref={ref}
      className="relative mt-3.5 rounded-[4px] outline-offset-4 touch-pan-y"
      tabIndex={0}
      role="group"
      aria-label={`${lab} ${line.label.toLowerCase()} capacity, measured. Arrow keys read hours; Shift moves a day.`}
      onKeyDown={onKey}
      onFocus={() => setHour((current) => current ?? facts.latest?.hour ?? null)}
      onBlur={() => setHour(null)}
    >
      <svg viewBox={`0 0 ${g.width} ${g.height}`} height={g.height} className="block w-full overflow-visible text-[11px] tabular-nums" aria-hidden="true"
        onPointerMove={onMove} onPointerLeave={() => setHour(null)}>
        <line x1={g.left} x2={g.width - g.right} y1={g.y(ceiling / 2)} y2={g.y(ceiling / 2)} stroke="var(--border)" />
        <text x={g.left - 6} y={g.y(ceiling / 2) + 4} textAnchor="end" fill="var(--muted-foreground)">{amount(ceiling / 2)}</text>
        <line x1={g.left} x2={g.width - g.right} y1={y0} y2={y0} stroke="var(--muted-foreground)" strokeOpacity={0.6} />
        <text x={g.left - 6} y={y0 + 4} textAnchor="end" fill="var(--foreground)" fontWeight={500}>0</text>
        {first && first.hour > from + hourMs && (
          <text x={(g.x(from) + g.x(first.hour)) / 2} y={g.top + (g.bottom - g.top) / 3} textAnchor="middle" fill="var(--muted-foreground)">Not tracked yet</text>
        )}
        {gaps(line.points, to).map((span) => (
          <g key={`gap-${span.from}`}>
            <rect x={g.x(span.from)} y={g.top} width={Math.max(2, g.x(span.to) - g.x(span.from))} height={y0 - g.top} fill="var(--accent)" stroke="var(--input)" strokeWidth={0.5} />
            {g.x(span.to) - g.x(span.from) > 60 && <text x={(g.x(span.from) + g.x(span.to)) / 2} y={g.top + 12} textAnchor="middle" fill="var(--muted-foreground)">no readings</text>}
          </g>
        ))}
        {outSpans(line.points).map((span) => (
          <g key={`out-${span.from}`}>
            <rect x={g.x(span.from)} y={g.top} width={Math.max(2, g.x(span.to) - g.x(span.from))} height={y0 - g.top} fill="var(--destructive)" opacity={0.13} />
            <rect x={g.x(span.from)} y={y0 - 2} width={Math.max(2, g.x(span.to) - g.x(span.from))} height={3} fill="var(--destructive)" />
          </g>
        ))}
        <path d={fullPath} fill="none" stroke="var(--muted-foreground)" strokeOpacity={0.8} strokeDasharray="1 3" />
        {ceiling > 0 && (
          <text x={g.left} y={g.y(ceiling) - 6} fill="var(--muted-foreground)">
            {g.small ? `Full ${amount(ceiling)} · reference` : `Full ${amount(ceiling)} ${unit} · every window fresh · reference, not available`}
          </text>
        )}
        {segments(line.points).map((run) => {
          const points = run.map((entry) => `${g.x(entry.hour + hourMs).toFixed(1)},${g.y(entry.minimum.remaining).toFixed(1)}`);
          const start = g.x(run[0]!.hour).toFixed(1);
          const startY = g.y(run[0]!.minimum.remaining).toFixed(1);
          const all = [`${start},${startY}`, ...points].join(" ");
          return (
            <g key={`run-${run[0]!.hour}`}>
              <polygon points={`${start},${y0} ${all} ${g.x(run.at(-1)!.hour + hourMs).toFixed(1)},${y0}`} fill={color} opacity={0.1} />
              <polyline points={all} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
            </g>
          );
        })}
        {facts.lowest && facts.lowest.hour !== facts.latest?.hour && (
          <g>
            <circle cx={g.x(facts.lowest.hour + hourMs)} cy={g.y(facts.lowest.minimum.remaining)} r={3.5} fill="var(--background)" stroke="var(--foreground)" strokeWidth={1.5} />
            <text x={g.x(facts.lowest.hour + hourMs)} y={g.y(facts.lowest.minimum.remaining) > g.top + 30 ? g.y(facts.lowest.minimum.remaining) - 9 : g.y(facts.lowest.minimum.remaining) + 16}
              textAnchor="middle" fill="var(--foreground)" fontWeight={500}>low {amount(facts.lowest.minimum.remaining)}</text>
          </g>
        )}
        <line x1={g.x(to)} x2={g.x(to)} y1={g.top - 8} y2={g.bottom} stroke="var(--foreground)" strokeOpacity={0.55} />
        <text x={g.x(to) - 4} y={g.top - 10} textAnchor="end" fill="var(--foreground)" fontWeight={500}>Now</text>
        {ticks.map((at) => (
          <g key={at}>
            <line x1={g.x(at)} x2={g.x(at)} y1={g.bottom} y2={g.bottom + 3} stroke="var(--input)" />
            <text x={g.x(at) + 3} y={g.bottom + 16} fill="var(--muted-foreground)">{every >= 4 ? dayLong(at).replace(/^\w+ /, "") : dayLabel(at)}</text>
          </g>
        ))}
        {hour !== null && (
          <g>
            <line x1={g.x(hour + hourMs)} x2={g.x(hour + hourMs)} y1={g.top - 4} y2={g.bottom} stroke="var(--foreground)" strokeOpacity={0.35} />
            {point && <circle cx={g.x(hour + hourMs)} cy={g.y(point.minimum.remaining)} r={4.5} fill={color} stroke="var(--background)" strokeWidth={2} />}
          </g>
        )}
      </svg>
      {hour !== null && (
        <div
          className="pointer-events-none absolute top-6 z-[5] w-max min-w-[220px] max-w-[300px] rounded-lg border border-border bg-background px-3 py-2.5 text-xs shadow-[var(--tooltip-shadow)]"
          style={tipLeft > 55 ? { right: `calc(${100 - tipLeft}% + 14px)` } : { left: `calc(${tipLeft}% + 14px)` }}
        >
          <Tip hour={hour} point={point} line={line} tracked={first !== undefined && hour >= first.hour} />
        </div>
      )}
      <p className="sr-only" aria-live="polite">{hour === null ? "" : describe(hour, point, unit, first !== undefined && hour >= first.hour)}</p>
    </div>
  );
}

function describe(hour: number, point: CapacityHistoryPoint | undefined, unit: string, tracked: boolean) {
  const when = `${dayLong(hour)} ${hourLabel(hour)} UTC`;
  if (!tracked) return `${when}: not tracked yet.`;
  if (!point) return `${when}: no readings.`;
  return `${when}: lowest ${amount(point.minimum.remaining)} of ${amount(point.minimum.full)} ${unit} left${isOut(point) ? ", every account out" : ""}.`;
}

function Tip({ hour, point, line, tracked }: { hour: number; point: CapacityHistoryPoint | undefined; line: CapacityLine; tracked: boolean }) {
  const unit = line.unit.label;
  const head = <div className="text-muted-foreground">{dayLong(hour)} · {hourLabel(hour)}–{hourLabel(hour + hourMs)} UTC · {line.label}</div>;
  if (!point)
    return (
      <>
        {head}
        <div className="mt-0.5 text-[13px]">{tracked ? "No readings this hour" : "Not tracked yet"}</div>
        {tracked && <div className="text-muted-foreground">Shown as a gap. Nothing is filled in.</div>}
      </>
    );
  const plans = point.plans.filter((plan) => plan.minimum.accountCount > 0);
  return (
    <>
      {head}
      <div className="mt-0.5 mb-1.5 text-[13px]">
        {isOut(point) && <span className="text-destructive">All accounts out · </span>}
        <b className="text-[15px] font-semibold tracking-[-0.015em] tabular-nums">{amount(point.minimum.remaining)}</b> of {amount(point.minimum.full)} {unit} left at the hour's low
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {plans.map((plan) => {
            const flagged = plan.minimum.unknownWeightCount > 0;
            const sources = [...new Set(plan.minimum.weights.map((weight) => weightSourceLabel[weight.source]))].join(", ");
            return (
              <tr key={planName(plan.plan)}>
                <td className="py-0.5 align-top">
                  {planName(plan.plan)} ×{plan.minimum.accountCount}
                  <span className={`block text-[11px] ${flagged ? "text-warning" : "text-muted-foreground"}`}>{flagged ? "⚑ " : ""}{sources}</span>
                </td>
                <td className="py-0.5 pl-2.5 text-right align-top whitespace-nowrap tabular-nums">{amount(plan.minimum.remaining)} / {amount(plan.minimum.full)}</td>
              </tr>
            );
          })}
          <tr className="font-medium">
            <td className="border-t border-border pt-1">Total</td>
            <td className="border-t border-border pt-1 text-right tabular-nums">{amount(point.minimum.remaining)} / {amount(point.minimum.full)}</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-1.5 grid gap-0.5 border-t border-border pt-1.5 text-muted-foreground">
        <span>Latest this hour: <b className="font-medium text-foreground tabular-nums">{amount(point.last.remaining)}</b> of {amount(point.last.full)} {unit}</span>
        <span>{point.minimum.accountCount} {point.minimum.accountCount === 1 ? "account" : "accounts"}{point.minimum.unknownWeightCount > 0 ? ` · ${point.minimum.unknownWeightCount} at a flagged 1x` : ""}</span>
      </div>
    </>
  );
}
