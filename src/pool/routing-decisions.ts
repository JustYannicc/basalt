import type { HomeClient } from "./control.ts";
import { object, unavailable, type Json } from "./json.ts";
import { poolGroupPrefix } from "./pool-group.ts";

export async function readRoutingDecisions(client: HomeClient, pool: string) {
  const groups = (await client.allPoolGroups()).filter(
    (group) => group.channel_name === `${poolGroupPrefix}${pool}`,
  );
  const pages: Json[] = [];
  let changedAt: string | undefined;
  for (const group of groups) {
    const [page, saved] = await Promise.all([
      client.data(`/channel-groups/${group.id}/routing-decisions?limit=20`),
      client.data(`/channel-groups/${group.id}`),
    ]);
    const record = object(saved.channel_group) ? saved.channel_group : saved;
    const at = typeof record.updated_at === "string" ? Date.parse(record.updated_at) : NaN;
    if (!Number.isFinite(at)) return unavailable();
    const changed = new Date(at).toISOString();
    if (changedAt === undefined || changed > changedAt) changedAt = changed;
    pages.push(page);
  }
  // No group is an authorized empty pool, not a reason to create saved state.
  return { pages, changedAt: changedAt ?? new Date(0).toISOString() };
}
