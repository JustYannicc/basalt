import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolOverviewResult } from "../overview-contract.ts";

/** A shared end instant is required; distinct capture watermarks are preserved as source freshness. */
export function coherentOverview(
  capacity: PoolCapacityHistory,
  usage: PoolOverviewResult,
  range: { from: string; to: string },
): boolean {
  return (
    !usage.partial &&
    usage.consistency === "consistent" &&
    usage.from === range.from &&
    usage.to === range.to &&
    usage.people.from === range.from &&
    usage.people.to === range.to &&
    usage.models.from === range.from &&
    usage.models.to === range.to &&
    usage.people.next === null &&
    usage.models.next === null &&
    usage.people.asOf === usage.models.asOf &&
    usage.people.asOf === usage.asOf &&
    capacity.to === Date.parse(range.to) &&
    capacity.from === Date.parse(range.from)
  );
}
