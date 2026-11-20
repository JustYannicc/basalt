import type { PoolReliabilitySlo } from "../../../apps/pool/reliability-contract.ts";
import { withHistoryDatabase, type HistoryDatabaseOptions } from "./database.ts";
import {
  reliabilityFailure,
  reliabilitySessionFailed,
  type ReliabilitySessionPhase,
} from "./reliability-read-failure.ts";
import { readPoolReliabilitySlo } from "./reliability-slo.ts";

/**
 * The reliability read in a session of its own, for the minute check-in and the capture. A failure
 * logs the timeout's own class and whether the session failed while connecting, in its statements or
 * while closing the connection, where no statement line can name it.
 */
export async function readReliabilityInSession(
  connectionString: string | undefined,
  pool: string,
  now?: number,
  options: Pick<HistoryDatabaseOptions, "createClient" | "signal"> = {},
): Promise<PoolReliabilitySlo> {
  let phase: ReliabilitySessionPhase = "connect";
  try {
    return await withHistoryDatabase(
      connectionString,
      async (db) => {
        phase = "statements";
        const slo = await readPoolReliabilitySlo(db, pool, now);
        phase = "close";
        return slo;
      },
      { ...options, timeoutFailure: "history" },
    );
  } catch (error) {
    // Logged here: a Durable Object call keeps only an error's message.
    console.error("POOL_REQUEST_RELIABILITY_READ_FAILED", {
      read: "standalone",
      step: "session",
      phase,
      ...reliabilityFailure(error),
    });
    throw new Error(reliabilitySessionFailed);
  }
}
