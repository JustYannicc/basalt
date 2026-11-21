import type { HistoryDatabase } from "./schema.ts";
import { HistoryDeadline, HistoryTimeoutFailure, historyTimeoutReason } from "./series-deadline.ts";
import { historyPhase, type HistorySeriesDiagnostics } from "./series-diagnostics.ts";

export interface HistoryDatabaseClient extends HistoryDatabase {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "error", listener: () => void): unknown;
  connection: { stream: { destroy(): unknown } };
}

export interface HistoryDatabaseOptions {
  totalTimeoutMs?: number;
  timeoutFailure?: "history";
  signal?: AbortSignal;
  diagnostics?: HistorySeriesDiagnostics;
  createClient?: (connectionString: string) => Promise<HistoryDatabaseClient>;
}

async function createClient(connectionString: string): Promise<HistoryDatabaseClient> {
  const { default: pg } = await import("pg");
  return new pg.Client({
    connectionString,
    connectionTimeoutMillis: 2_500,
    query_timeout: 6_000,
  });
}

/** One bounded session, never a driver error or SQL parameter in the log. */
export async function withHistoryDatabase<T>(
  connectionString: string | undefined,
  work: (db: HistoryDatabase) => Promise<T>,
  options: HistoryDatabaseOptions = {},
): Promise<T> {
  if (!connectionString) throw new Error("Model history database is unavailable");
  let client: HistoryDatabaseClient | undefined;
  const deadline = new HistoryDeadline(
    Math.max(1, Math.min(20_000, options.totalTimeoutMs ?? 20_000)),
    options.signal,
    () => client?.connection.stream.destroy(),
  );
  const bounded = async <R>(operation: () => Promise<R>): Promise<R> => {
    try {
      return await deadline.run(operation);
    } catch (error) {
      const reason = historyTimeoutReason(error);
      if (!reason) throw error;
      // The driver's error stays the cause, so a failed read can still name its Postgres code.
      const timeout =
        error instanceof HistoryTimeoutFailure
          ? error
          : Object.assign(new HistoryTimeoutFailure(reason), { cause: error });
      deadline.stop(timeout);
      throw timeout;
    }
  };
  const run = async () => {
    try {
      client = await (options.createClient ?? createClient)(connectionString);
      client.on("error", () => {});
      // A dynamically loaded driver may finish after cancellation. Never connect it then.
      if (deadline.signal.aborted) client.connection.stream.destroy();
      deadline.check();
      const session = client;
      await historyPhase(options.diagnostics, "database_connect", () =>
        bounded(() => session.connect()),
      );
      let statement = 0;
      return await work({
        query: async (text, values) => {
          deadline.check();
          return historyPhase(
            options.diagnostics,
            "sql_statement",
            () => bounded(() => session.query(text, values)),
            ++statement,
          );
        },
      });
    } finally {
      await client?.end().catch(() => {});
    }
  };
  try {
    return await deadline.run(run);
  } catch (error) {
    // Only signed series reads opt into the History-specific public timeout response.
    if (error instanceof HistoryTimeoutFailure && options.timeoutFailure !== "history")
      throw new Error("Model history database deadline exceeded", { cause: error });
    throw error;
  } finally {
    deadline.dispose();
  }
}
