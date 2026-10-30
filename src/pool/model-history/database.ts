import type { HistoryDatabase } from "./schema.ts";

/** One bounded session, never a driver error or SQL parameter in the log. */
export async function withHistoryDatabase<T>(
  connectionString: string | undefined,
  work: (db: HistoryDatabase) => Promise<T>,
): Promise<T> {
  if (!connectionString) throw new Error("Model history database is unavailable");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_500, query_timeout: 6_000 });
  client.on("error", () => {});
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.end().catch(() => {});
  }
}
