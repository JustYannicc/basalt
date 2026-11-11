import type { HomeClient } from "./control.ts";
import type {
  AccountUsageRouting,
  UsageCreditPolicy,
} from "../../apps/pool/usage-credits-contract.ts";
import { fail, object, post, rows, unavailable } from "./json.ts";
import { poolGroupPrefix } from "./pool-group.ts";

export function usageCreditPolicy(value: unknown): UsageCreditPolicy {
  if (value === "last_resort" || value === "never") return value;
  return unavailable();
}
const uses = new Set(["plan", "credits", "unknown", "exhausted", "blocked"]);
const reasons = new Set([
  "plan_available",
  "credits_only",
  "credits_disabled",
  "credit_policy_never",
  "usage_unknown",
  "quota_exhausted",
  "credential_unavailable",
  "continuity_requires_reconnect",
]);
function routing(value: unknown): AccountUsageRouting {
  if (
    !object(value) ||
    !uses.has(String(value.use)) ||
    !reasons.has(String(value.reason)) ||
    typeof value.eligible !== "boolean"
  )
    return unavailable();
  return {
    use: value.use as AccountUsageRouting["use"],
    reason: value.reason as AccountUsageRouting["reason"],
    eligible: value.eligible,
    policy: usageCreditPolicy(value.policy),
  };
}
async function groups(client: HomeClient, pool: string) {
  const name = `${poolGroupPrefix}${pool}`;
  return (await client.allPoolGroups()).filter((group) => group.channel_name === name);
}
export async function poolCreditRouting(client: HomeClient, pool: string) {
  const selected = await groups(client, pool);
  let policy: UsageCreditPolicy = "last_resort";
  const accounts: Record<string, AccountUsageRouting> = {};
  for (const group of selected) {
    const data = await client.data(`/channel-groups/${group.id}/usage-credit-routing`);
    const current = usageCreditPolicy(data.usageCreditPolicy);
    if (current === "never") policy = current;
    if (!object(data.accounts) || Object.keys(data.accounts).length > 500) return unavailable();
    for (const [id, value] of Object.entries(data.accounts)) {
      const entry = routing(value);
      // Duplicate groups must never make a stricter decision look permissive.
      if (accounts[id] === undefined || !entry.eligible || entry.policy === "never")
        accounts[id] = entry;
    }
  }
  if (policy === "never")
    for (const [id, value] of Object.entries(accounts)) {
      accounts[id] = {
        ...value,
        policy,
        ...(value.use === "credits" || value.use === "unknown"
          ? { use: "blocked", eligible: false, reason: "credit_policy_never" }
          : {}),
      };
    }
  return { usageCreditPolicy: policy, accounts };
}
export async function setPoolCreditPolicy(client: HomeClient, pool: string, value: unknown) {
  if (value !== "last_resort" && value !== "never")
    return fail(400, "invalid_query", "Choose a valid subscription credit policy.");
  let selected = await groups(client, pool);
  if (selected.length === 0) {
    await client.data("/channel-groups", post({ channel_name: `${poolGroupPrefix}${pool}` }));
    selected = await groups(client, pool);
    if (selected.length === 0) return unavailable();
  }
  for (const group of selected)
    await client.data(`/channel-groups/${group.id}`, {
      ...post({ usage_credit_policy: value }),
      method: "PATCH",
    });
  // Read every group freshly; a partial write must never acknowledge an unconfirmed policy.
  const actual = rows((await client.data("/channel-groups")).channel_groups).filter((row) =>
    selected.some((group) => row.id === group.id),
  );
  if (actual.length !== selected.length || actual.some((row) => row.usage_credit_policy !== value))
    return unavailable();
  client.invalidateGroups();
  return { success: true as const };
}
