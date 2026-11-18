import pg from "pg";
import { fileURLToPath } from "node:url";

const appId = /^app_[A-Za-z0-9_-]{1,120}$/u;

export function unregisteredPools(value: string | undefined): string[] {
  const pools = (value ?? "").split(",").map((pool) => pool.trim());
  if (
    pools.length < 1 ||
    pools.length > 20 ||
    pools.some((pool) => !appId.test(pool)) ||
    new Set(pools).size !== pools.length
  )
    throw new Error("The rehearsal fixture needs distinct pool app ids");
  return pools;
}

/**
 * Remove the named pools' native registrations from one organization in one transaction, and
 * refuse unless exactly those pools were registered. The column may be text or jsonb.
 */
type Query = {
  query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
};

export async function unregisterPools(
  client: Query,
  organization: string,
  pools: readonly string[],
): Promise<number> {
  await client.query("begin");
  try {
    const column = await client.query<{ data_type: string }>(
      "select data_type from information_schema.columns where table_schema = current_schema() and table_name = 'organization' and column_name = 'metadata'",
    );
    const type = column.rows[0]?.data_type;
    if (type !== "text" && type !== "jsonb")
      throw new Error("Unexpected organization metadata column");
    const result = await client.query<{ removed: string }>(
      `with target as (
         select o.id, coalesce(o.metadata::jsonb, '{}'::jsonb) as m from organization o where o.id = $1 for update
       ), kept as (
         select coalesce(jsonb_object_agg(e.key, e.value) filter (where not (e.value ->> 'app' = any($2::text[]))), '{}'::jsonb) as pools,
                count(*) filter (where e.value ->> 'app' = any($2::text[])) as removed
         from target cross join lateral jsonb_each(coalesce(target.m -> 'basaltPools', '{}'::jsonb)) e
       )
       update organization o set metadata = jsonb_set(t.m, '{basaltPools}', k.pools)${type === "text" ? "::text" : ""}
       from target t, kept k where o.id = t.id returning k.removed`,
      [organization, [...pools]],
    );
    const removed = Number(result.rows[0]?.removed ?? 0);
    if (result.rowCount !== 1 || removed !== pools.length)
      throw new Error("The rehearsal fixture did not find exactly the named pool registrations");
    await client.query("commit");
    return removed;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    const pools = unregisteredPools(process.env.REHEARSAL_UNREGISTERED_POOLS);
    await client.connect();
    const removed = await unregisterPools(client, process.env.REHEARSAL_ORGANIZATION ?? "", pools);
    console.log(`Rehearsal fixture removed ${removed} native pool registrations`);
  } catch {
    console.error("Rehearsal fixture failed");
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
