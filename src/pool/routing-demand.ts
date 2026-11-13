import { capacityAccountReferences } from "./capacity/account-reference.ts";
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
  credentials: readonly string[],
  forecasts?: readonly RoutingDemandInput[],
  outlooks?: readonly CapacityOutlook[],
): Promise<void> {
  const references = await capacityAccountReferences(pool, credentials);
  const observed = observedRoutingDemand(data, now, references);
  const current = new Set(credentials);
  if (
    forecasts?.some((input) =>
      input.windows.some((window) =>
        window.accounts.some((account) => !current.has(account.account)),
      ),
    )
  )
    throw new Error("Routing forecast must use current Home credential references");
  const freshForecasts = forecasts?.filter(
    (input) =>
      input.source === "history-forecast" &&
      Date.parse(input.calculatedAt) <= now &&
      Date.parse(input.validUntil) > now &&
      input.history.coverageRatio >= 0.9 &&
      !input.history.censored,
  );
  const inputs = [...observed, ...(freshForecasts ?? [])];
  const groups = (await client.allPoolGroups()).filter(
    (group) => group.channel_name === `${poolGroupPrefix}${pool}`,
  );
  if (!groups.length) return;
  const ids = groups.map((group) => group.id).sort((a, b) => a - b);
  // Duplicate channel groups form one scheduling scope. Whole-pool demand must
  // never be assigned to a partial inventory from just one duplicate.
  await client.data(`/channel-groups/${ids[0]}/routing-demand`, {
    ...post({
      groups: ids,
      inputs,
      capacity: outlooks ?? [],
      replaceSources: [
        "observed-quota-burn",
        ...(forecasts === undefined && outlooks === undefined ? [] : ["history-forecast"]),
      ],
    }),
    method: "PUT",
  });
}
