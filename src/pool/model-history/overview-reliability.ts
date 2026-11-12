import type { PoolOverviewReliability } from "../../../apps/pool/reliability-contract.ts";
import type { HistoryDatabase } from "./schema.ts";
import { readPoolReliability } from "./reliability.ts";
import { readPoolReliabilitySlo } from "./reliability-slo.ts";

/** Optional monitoring cannot poison the transaction serving request, token and cost answers. */
export async function readOverviewReliability(
  db: HistoryDatabase,
  pool: string,
  from: string,
  to: string,
  now: number,
): Promise<PoolOverviewReliability> {
  await db.query("SAVEPOINT overview_reliability");
  try {
    const result = {
      range: await readPoolReliability(db, pool, from, to),
      slo: await readPoolReliabilitySlo(db, pool, now, "caller"),
    };
    await db.query("RELEASE SAVEPOINT overview_reliability");
    return result;
  } catch {
    await db.query("ROLLBACK TO SAVEPOINT overview_reliability");
    await db.query("RELEASE SAVEPOINT overview_reliability");
    return { unavailable: true };
  }
}
