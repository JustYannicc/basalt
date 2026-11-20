import type { PoolReliabilitySlo } from "../../../apps/pool/reliability-contract.ts";
import { withHistoryDatabase, type HistoryDatabaseOptions } from "./database.ts";
import { readPoolReliabilitySlo } from "./reliability-slo.ts";

/** The reliability read in a session of its own, for the minute check-in and the capture. */
export function readReliabilityInSession(
  connectionString: string | undefined,
  pool: string,
  now?: number,
  options: Pick<HistoryDatabaseOptions, "createClient" | "signal"> = {},
): Promise<PoolReliabilitySlo> {
  return withHistoryDatabase(
    connectionString,
    (db) => readPoolReliabilitySlo(db, pool, now),
    options,
  );
}
