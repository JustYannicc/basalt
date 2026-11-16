import {
  reliabilityNotificationMinimumRequests,
  type PoolReliabilitySlo,
} from "../../apps/pool/reliability-contract.ts";
import { reportingCadence } from "./reporting.ts";

/** Normal batching leaves recent usage pending without establishing a reliable objective. */
export function notifyCollectionFailure(slo: PoolReliabilitySlo, now = Date.now()): boolean {
  if (slo.state !== "unavailable") return false;
  if (slo.reason !== "capture_lagging" || slo.captureAt === null) return true;
  const captured = Date.parse(slo.captureAt);
  return !Number.isFinite(captured) || captured > now || now - captured >= reportingCadence;
}

/** Raw SLI breaches outlive failures; only a sampled, still-active breach earns percentage paging. */
export function notifyPercentageFailure(slo: PoolReliabilitySlo): boolean {
  if (
    slo.state !== "breached" ||
    slo.current?.classification !== "ready" ||
    slo.current.real.failed === 0
  )
    return false;
  return [slo.hour, slo.day].some(
    ({ classification, real }) =>
      classification === "ready" &&
      real.requests >= reliabilityNotificationMinimumRequests &&
      BigInt(real.failed) * 100n > BigInt(real.requests),
  );
}
