import type { AppUsage } from "../../../apps/pool/contract.ts";
import { digest } from "../backend-users.ts";
import { appAttributionReady, type HistoryDatabase } from "./schema.ts";

/** App and person breakdowns read the same immutable request rows as the history view. */
export async function appUsage(db: HistoryDatabase, input: {
  pool: string; members: readonly string[]; from: string; to: string;
}): Promise<Map<string, AppUsage[]> | undefined> {
  if (!await appAttributionReady(db)) return undefined;
  const people = new Map(await Promise.all(input.members.map(async (id) => [await digest(id), id] as const)));
  if (!people.size) return new Map();
  const pool = (await digest(input.pool)).slice(0, 16);
  const result = await db.query(`SELECT person, app_id, requirement, count(*)::text AS requests,
    coalesce(sum(cost),0)::text AS cost, count(*) filter (where cost_basis = 'unpriced')::text AS unpriced,
    coalesce(sum(input_tokens),0)::text AS input, coalesce(sum(output_tokens),0)::text AS output,
    coalesce(sum(cache_read_tokens),0)::text AS cache_read, coalesce(sum(cache_write_tokens),0)::text AS cache_write,
    coalesce(sum(total_tokens),0)::text AS total
    FROM basalt_model_requests WHERE pool=$1 AND person=ANY($2::text[]) AND timestamp >= $3 AND timestamp < $4
    GROUP BY person, app_id, requirement ORDER BY person, app_id NULLS LAST, requirement`,
  [pool, [...people.keys()], input.from, input.to]);
  const byPerson = new Map<string, AppUsage[]>();
  const count = (raw: unknown, integer = true) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || integer && !Number.isSafeInteger(value))
      throw new Error("Model usage aggregate is invalid");
    return value;
  };
  for (const row of result.rows) {
    const member = people.get(String(row.person));
    if (!member) throw new Error("Model usage aggregate has another person");
    const app = row.app_id === null ? null : String(row.app_id);
    const requirement = row.requirement === null ? null : String(row.requirement);
    const entry: AppUsage = { app, requirement, requests: count(row.requests), cost: count(row.cost, false),
      unpriced: count(row.unpriced), tokens: { input: count(row.input), output: count(row.output),
        cacheRead: count(row.cache_read), cacheWrite: count(row.cache_write), total: count(row.total) } };
    byPerson.set(member, [...(byPerson.get(member) ?? []), entry]);
  }
  return byPerson;
}
