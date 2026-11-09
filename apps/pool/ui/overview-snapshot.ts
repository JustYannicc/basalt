import { overviewAccounts } from "./overview-accounts.ts";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolView } from "../contract.ts";
import type { Result } from "../index.ts";
import type { PoolOverviewResult } from "../overview-contract.ts";

/**
 * Capacity and usage must cover one range from one usage capture. `partial` and a further page only
 * mean incomplete coverage. The server marks a changed capture `changed`, and the usage sections
 * keep their own coverage notes, so coverage never withholds the capacity verdict.
 */
export function coherentOverview(
  capacity: PoolCapacityHistory,
  usage: PoolOverviewResult,
  range: { from: string; to: string },
): boolean {
  return (
    usage.consistency === "consistent" &&
    usage.from === range.from &&
    usage.to === range.to &&
    usage.people.from === range.from &&
    usage.people.to === range.to &&
    usage.models.from === range.from &&
    usage.models.to === range.to &&
    usage.people.asOf === usage.models.asOf &&
    usage.people.asOf === usage.asOf &&
    capacity.to === Date.parse(range.to) &&
    capacity.from === Date.parse(range.from)
  );
}

/**
 * Capacity is about the accounts the pool has now. Readings outlive an account's removal, so a lab
 * with no current account drops out instead of claiming capacity the pool no longer holds.
 */
export function currentCapacity(
  capacity: Result<PoolCapacityHistory> | undefined,
  view: PoolView | undefined,
): Result<PoolCapacityHistory> | undefined {
  if (!view || !capacity?.ok) return capacity;
  const labs = new Set(overviewAccounts(view).map((account) => account.provider));
  const value = capacity.value;
  return {
    ok: true,
    value: {
      ...value,
      points: value.points.filter((point) => labs.has(point.provider)),
      forecasts: value.forecasts.filter((forecast) => labs.has(forecast.provider)),
      refillEvents: value.refillEvents.filter((event) => labs.has(event.provider)),
    },
  };
}
