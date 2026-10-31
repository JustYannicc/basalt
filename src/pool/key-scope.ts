import { homeApiKeyCandidates } from "./model-auth.ts";
import { withHistoryDatabase } from "./model-history/database.ts";
import { poolGroupPrefix } from "./control.ts";
import { parseBackendUserName } from "./backend-users.ts";

export interface ModelKeyScope {
  keyId: number;
  pools: readonly string[];
  unrestricted: boolean;
  person: string | null;
}

/** Scope follows Home's first active credential and actual channel rows, never a request header. */
export async function modelKeyScope(connectionString: string | undefined, request: Request): Promise<ModelKeyScope | undefined> {
  const { values } = homeApiKeyCandidates(request);
  if (!values.length) return undefined;
  return withHistoryDatabase(connectionString, async (db) => {
    for (const key of values) {
      const result = await db.query(`SELECT k.id, k.channels, u.username FROM api_key k
        LEFT JOIN "user" u ON u.id = k.user_id
        WHERE k.api_key = $1 AND k.deleted_at IS NULL`, [key]);
      const row = result.rows[0];
      if (!row) continue;
      const keyId = Number(row.id);
      const channels: unknown = typeof row.channels === "string" ? JSON.parse(row.channels) : row.channels;
      if (!Number.isSafeInteger(keyId) || keyId <= 0 || !Array.isArray(channels)
        || !channels.every((value) => Number.isSafeInteger(value) && Number(value) > 0))
        throw new Error("Model key scope is unavailable");
      const person = parseBackendUserName(row.username)?.person ?? null;
      if (!channels.length) return { keyId, pools: [], unrestricted: true, person };
      const groups = await db.query(`SELECT id, channel_name FROM channel_group
        WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [channels]);
      const pools = groups.rows.flatMap((group) => typeof group.channel_name === "string"
        && group.channel_name.startsWith(poolGroupPrefix) ? [group.channel_name.slice(poolGroupPrefix.length)] : []);
      return { keyId, pools: [...new Set(pools)].sort(), unrestricted: false, person };
    }
    return undefined;
  });
}
