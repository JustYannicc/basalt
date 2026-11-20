import {
  reliabilityNotificationMinimumRequests,
  type PoolReliabilitySlo,
} from "../../apps/pool/reliability-contract.ts";
import { windowVerdict } from "./model-history/reliability-unknown.ts";

/**
 * An objective left unavailable by its unknown outcomes pages only when a window they decide has
 * enough real requests to page a breach, the unknown ones the window never counted included; doubt
 * never pages louder than a breach would. Every other reason it is unavailable still pages, and the
 * figure keeps saying unavailable either way.
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

/** Raw SLI breaches outlive failures; only a sampled, still-active breach earns percentage paging. */
export function notifyPercentageFailure(slo: PoolReliabilitySlo): boolean {
  if (
    slo.state !== "breached" ||
    slo.current?.classification !== "ready" ||
    slo.current.real.failed === 0
  )
    return false;
  // The window that pages must itself be breached, unknown outcomes included.
  return [slo.hour, slo.day].some(
    (window) =>
      window.classification === "ready" &&
      window.real.requests >= reliabilityNotificationMinimumRequests &&
      windowVerdict(window) === "breached",
  );
}
