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
 * logs one session line: the first failure's own class and whether the session failed while
 * connecting, in its statements or while closing the connection, plus how closing failed after a
 * statement failure.
 */
export async function readReliabilityInSession(
  connectionString: string | undefined,
  pool: string,
  now?: number,
  options: Pick<HistoryDatabaseOptions, "createClient" | "signal"> = {},
): Promise<PoolReliabilitySlo> {
  let phase: ReliabilitySessionPhase = "connect";
  let statements: { error: unknown } | undefined;
  try {
    return await withHistoryDatabase(
      connectionString,
      async (db) => {
        phase = "statements";
        const slo = await readPoolReliabilitySlo(db, pool, now).catch((error: unknown) => {
          statements = { error };
          throw error;
        });
        phase = "close";
        return slo;
      },
      { ...options, timeoutFailure: "history" },
    );
  } catch (error) {
    // Classified here: across a Durable Object call an error loses its class, which the timeout
    // classes depend on. The fixed message keeps driver details from crossing.
    const closing = statements !== undefined && error !== statements.error;
    console.error("POOL_REQUEST_RELIABILITY_READ_FAILED", {
      read: "standalone",
      step: "session",
      phase,
      ...reliabilityFailure(statements ? statements.error : error),
      ...(closing ? { close: reliabilityFailure(error).failure } : {}),
    });
    throw new Error(reliabilitySessionFailed);
  }
}
