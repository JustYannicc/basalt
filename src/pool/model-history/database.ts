import type { HistoryDatabase } from "./schema.ts";

/** One bounded session, never a driver error or SQL parameter in the log. */
export async function withHistoryDatabase<T>(
  connectionString: string | undefined,
  work: (db: HistoryDatabase) => Promise<T>,
): Promise<T> {
  if (!connectionString) throw new Error("Model history database is unavailable");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_500, query_timeout: 6_000, statement_timeout: 5_000 });
  client.on("error", () => {});
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      // Match the model-key lookup's pg@8.16.3 half-open socket close path.
      try { client.connection.stream.destroy(); } catch { /* The operation still fails closed. */ }
      reject(new Error("Model history database deadline exceeded"));
    }, 20_000);
  });
  const run = async () => {
    try {
      await client.connect();
      return await work({ query: async (text, values) => {
        if (expired) throw new Error("Model history database deadline exceeded");
        return client.query(text, values);
      } });
    } finally { await client.end().catch(() => {}); }
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally { clearTimeout(timer); }
}
