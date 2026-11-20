import {
  reliabilityNotificationMinimumRequests,
  type PoolReliabilitySlo,
} from "../../apps/pool/reliability-contract.ts";
import { windowVerdict } from "./model-history/reliability-unknown.ts";

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
