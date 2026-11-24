import type { HistoryDatabase } from "./schema.ts";
import {
  historyUsagePeopleRollupVersion,
  usagePeopleRollupKeys,
  usagePeopleRollupNames,
} from "./usage-rollup-people-schema.ts";
import {
  historyUsageRollupVersion,
  usageRollupKeys,
  usageRollupNames,
  usageRollupProjection,
} from "./usage-rollup-schema.ts";

/** Which hourly rollup: v15 without person or app, or v16 with both. */
export type UsageRollupTarget = "v15" | "v16";

export const usageRollupTargets = {
  v15: {
    version: historyUsageRollupVersion,
    ...usageRollupNames,
    projection: (rows: string) => usageRollupProjection(rows, usageRollupKeys),
  },
  v16: {
    version: historyUsagePeopleRollupVersion,
    ...usagePeopleRollupNames,
    projection: (rows: string) => usageRollupProjection(rows, usagePeopleRollupKeys),
  },
} as const;

export const isUsageRollupTarget = (value: unknown): value is UsageRollupTarget =>
  value === "v15" || value === "v16";

/** The newest rollup whose migration this database applied, which backfills target; or none. */
export async function activeUsageRollupTarget(
  db: HistoryDatabase,
): Promise<UsageRollupTarget | undefined> {
  const applied = new Set(
    (
      await db.query(
        "SELECT name FROM basalt_model_history_migrations WHERE name=ANY($1::text[])",
        [[historyUsageRollupVersion, historyUsagePeopleRollupVersion]],
      )
    ).rows.map((row) => String(row.name)),
  );
  return applied.has(historyUsagePeopleRollupVersion)
    ? "v16"
    : applied.has(historyUsageRollupVersion)
      ? "v15"
      : undefined;
}
