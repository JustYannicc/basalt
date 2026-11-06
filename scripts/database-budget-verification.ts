import { setTimeout as delay } from "node:timers/promises";
import {
  databaseBackendBudget,
  retirement,
} from "../.upstream/apps/hosted/cloud/src/infrastructure/database-pool-policy.ts";
export { databaseBackendBudget, retirement };

export interface BackendCount {
  database: string;
  connections: number;
}

/** Count runtime logins across both transports, so old direct sessions cannot hide during rollout. */
export const backendCountSql = `
  SELECT datname AS database, count(*)::int AS connections
  FROM pg_stat_activity
  WHERE usename = ANY($1::text[]) AND backend_type = 'client backend'
  GROUP BY datname`;

export async function verifyDatabaseBudget(options: {
  databases: readonly string[];
  read: () => Promise<BackendCount[]>;
  deadlineMs?: number;
  now?: () => number;
  wait?: () => Promise<void>;
  signal?: AbortSignal;
}) {
  const now = options.now ?? performance.now.bind(performance);
  const deadline = now() + (options.deadlineMs ?? retirement.verificationMs);
  const wait = options.wait ?? (() => delay(1_000, undefined, { signal: options.signal }));
  let counts: BackendCount[] = [];
  do {
    options.signal?.throwIfAborted();
    counts = await options.read();
    if (
      counts.every(
        (row) =>
          options.databases.includes(row.database) &&
          Number.isInteger(row.connections) &&
          row.connections >= 0 &&
          row.connections <= databaseBackendBudget,
      )
    ) {
      return counts;
    }
    if (now() >= deadline) break;
    await wait();
  } while (now() <= deadline);
  // Counts and database names are safe; role names, credentials and endpoints never enter diagnostics.
  throw new Error(
    `Database backend budget did not converge within ${options.deadlineMs ?? retirement.verificationMs}ms: ${JSON.stringify(counts)}`,
  );
}
