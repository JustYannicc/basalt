import type { HomeClient } from "./control.ts";
import { object, unavailable, type Json } from "./json.ts";
import { poolGroupPrefix } from "./pool-group.ts";

export async function readRoutingDecisions(client: HomeClient, pool: string) {
  const groups = (await client.allPoolGroups()).filter(
    (group) => group.channel_name === `${poolGroupPrefix}${pool}`,
  );
  const pages: Json[] = [];
  let changedAt: string | undefined;
  if (!groups.length) return { pages, changedAt: new Date(0).toISOString() };
  const ids = groups.map((group) => group.id).sort((a, b) => a - b);
  for (const group of groups) {
    const saved = await client.data(`/channel-groups/${group.id}`);
    const record = object(saved.channel_group) ? saved.channel_group : saved;
    const at = typeof record.updated_at === "string" ? Date.parse(record.updated_at) : NaN;
    if (!Number.isFinite(at)) return unavailable();
    const changed = new Date(at).toISOString();
    if (changedAt === undefined || changed > changedAt) changedAt = changed;
  }
  pages.push(
    await client.data(
      `/channel-groups/${ids[0]}/routing-decisions?groups=${ids.join(",")}&limit=20`,
    ),
  );
  return { pages, changedAt: changedAt! };
}
