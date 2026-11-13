import type { CapacityOutlook } from "../../apps/pool/routing-contract.ts";
import type { HomeClient } from "./control.ts";
import type { CapacityDemandData } from "./capacity/history.ts";
import type { RoutingDemandInput } from "./routing-demand-contract.ts";
import { poolGroupPrefix } from "./pool-group.ts";
import { post } from "./json.ts";
import { observedRoutingDemand } from "./routing-observed-demand.ts";

/** Publishing is alarm work. Inference only reads the bounded Home snapshot. */
export async function publishRoutingDemand(
  client: HomeClient,
  pool: string,
  data: CapacityDemandData,
  now: number,
  forecasts?: readonly RoutingDemandInput[],
  outlooks?: readonly CapacityOutlook[],
): Promise<void> {
  const observed = observedRoutingDemand(data, now);
  const freshForecasts = forecasts?.filter(
    (input) =>
      input.source === "history-forecast" &&
      Date.parse(input.calculatedAt) <= now &&
      Date.parse(input.validUntil) > now &&
      input.history.coverageRatio >= 0.9 &&
      !input.history.censored,
  );
  const inputs = [...observed, ...(freshForecasts ?? [])];
  for (const group of (await client.allPoolGroups()).filter(
    (group) => group.channel_name === `${poolGroupPrefix}${pool}`,
  )) {
    const path = `/channel-groups/${group.id}/routing-demand`;
    // One publication atomically replaces only the sources this producer owns.
    await client.data(path, {
      ...post({
        inputs,
        capacity: outlooks ?? [],
        replaceSources: [
          "observed-quota-burn",
          ...(forecasts === undefined ? [] : ["history-forecast"]),
        ],
      }),
      method: "PUT",
    });
  }
}
