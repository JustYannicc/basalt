import {
  usageRollupKeys,
  usageRollupStatements,
  type UsageRollupNames,
} from "./usage-rollup-schema.ts";

export const historyUsagePeopleRollupVersion = "model_request_history_v16_usage_rollup_people";

/**
 * The v15 keys plus the person and the app: every dimension the history series groups by, so the
 * series and the summary can both read one rollup. Each group still holds counts and sums only.
 */
export const usagePeopleRollupKeys = [...usageRollupKeys, "person", "app_id"] as const;

export const usagePeopleRollupNames: UsageRollupNames = {
  hourly: "basalt_model_usage_people_hourly",
  hours: "basalt_model_usage_people_hours",
  ready: "basalt_model_usage_people_ready",
  rollup: "basalt_model_usage_people_rollup",
  recompute: "basalt_model_usage_people_recompute",
};

/**
 * Additive only: new tables, functions and a trigger beside v15's, which keeps running. The
 * trigger takes the same shared per-pool lock, so a recompute of either rollup holds both
 * triggers' writers alike. The migration copies no row; the backfill fills past hours.
 */
export const historyUsagePeopleRollupStatements = usageRollupStatements(
  usagePeopleRollupNames,
  usagePeopleRollupKeys,
  // The request table's own types, so a group's key is the requests' values exactly.
  "\n    person char(64), app_id varchar(256),",
);
