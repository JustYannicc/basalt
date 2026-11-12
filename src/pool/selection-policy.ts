import type { AccountSelectionPolicy } from "../../apps/pool/usage-credits-contract.ts";
import type { HomeClient } from "./control.ts";
import { fail, post, rows, unavailable } from "./json.ts";
import { poolGroupPrefix } from "./pool-group.ts";

export function accountSelectionPolicy(value: unknown): AccountSelectionPolicy {
  if (value === "reset_aware" || value === "balanced") return value;
  return unavailable();
}

export async function setPoolSelectionPolicy(client: HomeClient, pool: string, value: unknown) {
  if (value !== "reset_aware" && value !== "balanced")
    return fail(400, "invalid_query", "Choose a valid account selection policy.");
  const name = `${poolGroupPrefix}${pool}`;
  let selected = (await client.allPoolGroups()).filter((group) => group.channel_name === name);
  if (selected.length === 0) {
    await client.data("/channel-groups", post({ channel_name: name }));
    selected = (await client.allPoolGroups()).filter((group) => group.channel_name === name);
    if (selected.length === 0) return unavailable();
  }
  for (const group of selected)
    await client.data(`/channel-groups/${group.id}`, {
      ...post({ account_selection_policy: value }),
      method: "PATCH",
    });
  const actual = rows((await client.data("/channel-groups")).channel_groups).filter((row) =>
    selected.some((group) => row.id === group.id),
  );
  if (
    actual.length !== selected.length ||
    actual.some((row) => row.account_selection_policy !== value)
  )
    return unavailable();
  client.invalidateGroups();
  return { success: true as const };
}
