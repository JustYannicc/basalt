import {
  reliabilityNotificationMinimumRequests,
  type PoolReliabilitySlo,
} from "../../apps/pool/reliability-contract.ts";
import { windowVerdict } from "./model-history/reliability-unknown.ts";

/**
 * An objective left unavailable by its unknown outcomes pages only when a window they decide has at
 * least as many real requests as a breach needs to page, the unknown ones the window never counted
 * included, so a quiet window's doubt doesn't page every minute. Every other reason it is
 * unavailable still pages, and the figure keeps saying unavailable either way.
 */
export function notifyCollectionUnavailable(slo: PoolReliabilitySlo): boolean {
  if (slo.state !== "unavailable") return false;
  // These are the reasons unknown outcomes give; a stale or inactive capture keeps its own.
  if (
    slo.reason !== "terminal_collection_pending" &&
    slo.reason !== "terminal_collection_unavailable"
  )
    return true;
  const windows = [slo.hour, slo.day];
  // Counts that aren't whole numbers can't show a window is quiet.
  const counts = windows.flatMap((window) => [
    window.real.requests,
    window.real.failed,
    window.unknown?.uncounted ?? 0,
    window.unknown?.couldFail ?? 0,
  ]);
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) return true;
  const undecided = windows.filter((window) => windowVerdict(window) === "undecided");
  return (
    undecided.length === 0 ||
    undecided.some(
      (window) =>
        window.real.requests + (window.unknown?.uncounted ?? 0) >=
        reliabilityNotificationMinimumRequests,
    )
  );
}

/**
 * The windows a percentage page is decided on: the current one that keeps the breach active, and
 * each hour or day window that is itself breached, unknown outcomes included. None when it doesn't page.
 */
export function percentageFailureWindows(slo: PoolReliabilitySlo): ("current" | "hour" | "day")[] {
  if (
    slo.state !== "breached" ||
    slo.current?.classification !== "ready" ||
    slo.current.real.failed === 0
  )
    return [];
  const breached = (["hour", "day"] as const).filter(
    (name) =>
      slo[name].classification === "ready" &&
      slo[name].real.requests >= reliabilityNotificationMinimumRequests &&
      windowVerdict(slo[name]) === "breached",
  );
  return breached.length ? ["current", ...breached] : [];
}

/** Raw SLI breaches outlive failures; only a sampled, still-active breach earns percentage paging. */
export function notifyPercentageFailure(slo: PoolReliabilitySlo): boolean {
  return percentageFailureWindows(slo).length > 0;
}
