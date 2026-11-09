import { overviewAccounts } from "./overview-accounts.ts";
import type { PoolView } from "../contract.ts";
import { Button } from "./controls.tsx";
import { duration, exactTime, lastReading } from "./usage.ts";

function ago(at: number, now: number): string {
  return now - at < 60_000 ? "just now" : `${duration(now - at)} ago`;
}

/** When the retained view was put together: the last of its Home reads to finish. */
function savedAt(view: PoolView): number | null {
  const times = Object.values(view.reading?.readAt ?? {})
    .map((iso) => Date.parse(iso))
    .filter((at) => !Number.isNaN(at));
  return times.length ? Math.max(...times) : null;
}

/**
 * Usage times are always the providers' own. A retained view says so until a live read replaces
 * it, and a failed update says it failed instead of presenting the old reading as current.
 */
export function Freshness({
  view,
  updating,
  now,
  onRetry,
}: {
  view: PoolView;
  updating: boolean;
  now: number;
  onRetry?: () => void;
}) {
  const reading = lastReading(overviewAccounts(view));
  const retained = view.reading?.source === "snapshot";
  const failed = retained && view.reading?.revalidationFailed === true;
  const saved = retained ? savedAt(view) : null;
  if (reading === null && !retained) return null;
  const savedText = saved === null ? "a saved view" : `a saved view from ${ago(saved, now)}`;
  const status = !retained
    ? null
    : failed
      ? `Couldn't update; showing ${savedText}`
      : updating
        ? "Saved view, updating…"
        : `Showing ${savedText}`;
  const title = [
    reading === null ? null : `Usage read ${new Date(reading).toLocaleString()}`,
    saved === null ? null : `Saved view from ${exactTime(new Date(saved).toISOString())}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <p className="text-xs text-muted-foreground tabular-nums" title={title || undefined}>
      {reading !== null && <>Usage read {ago(reading, now)}</>}
      {reading !== null && status && " · "}
      {status && <span className={failed ? "text-destructive" : undefined}>{status}</span>}
      {failed && onRetry && (
        <>
          {" · "}
          <Button size="inline" variant="link" className="text-xs" onClick={onRetry}>
            Try again
          </Button>
        </>
      )}
    </p>
  );
}
