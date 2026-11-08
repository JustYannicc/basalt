import type { HistorySeriesRead } from "./history-model.ts";
import { monthCounts } from "./history-model.ts";

export function HistoryChart({ groups }: { groups: HistorySeriesRead["groups"] }) {
  const months = monthCounts(groups);
  if (months.length === 0)
    return (
      <p className="border-b border-border pb-5 text-sm text-muted-foreground">
        No monthly usage in this range.
      </p>
    );
  const peak = Math.max(...months.map(({ requests }) => requests), 1);
  return (
    <figure className="m-0 grid gap-2 border-b border-border pb-5">
      <div
        className="grid min-w-0 gap-2 overflow-x-auto"
        role="img"
        aria-label={`Monthly requests: ${months.map(({ month, requests }) => `${month} ${requests.toLocaleString()}`).join(", ")}`}
        style={{ gridTemplateColumns: `repeat(${months.length}, minmax(2.5rem, 1fr))` }}
      >
        {months.map(({ month, requests }) => (
          <div key={month} className="grid h-28 grid-rows-[1fr_auto] gap-2 text-center">
            <div className="flex h-full items-end justify-center border-b border-border">
              <div
                title={`${month}: ${requests.toLocaleString()} requests`}
                className="w-full max-w-8 rounded-t-[2px] bg-foreground/65"
                style={{ height: `${Math.max((requests / peak) * 100, 1)}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{month.slice(2)}</span>
          </div>
        ))}
      </div>
      <figcaption className="text-xs text-muted-foreground">
        Requests by month · all sources
      </figcaption>
    </figure>
  );
}
