import { poolObservation, type PoolFact } from "../common/conditions.ts";
import type { Checkpoint, Observation } from "../common/types.ts";
import { poolAccountsObservation } from "./account-condition.ts";

export function poolStatusObservation(fact: PoolFact, previous: Checkpoint): Observation {
  const quota = poolObservation(fact, previous);
  const accounts = poolAccountsObservation(fact, previous);
  // Quota hysteresis survives account failures without imposing its threshold on account recovery.
  const quotaOpen =
    quota.verdict === "action" ||
    (previous.open &&
      (previous.observation.poolQuotaOpen ??
        ["pool-low", "pool-exhausted"].includes(previous.observation.code)) &&
      quota.verdict !== "healthy");
  const selected =
    accounts.verdict === "action"
      ? accounts
      : quota.verdict === "action" || quotaOpen
        ? quota
        : accounts.verdict === "withdraw"
          ? accounts
          : quota;
  return {
    ...quota,
    cursor: JSON.stringify([quota.cursor, accounts.cursor, quotaOpen]),
    poolQuotaOpen: quotaOpen,
    verdict:
      selected.verdict === "action" || selected.verdict === "withdraw"
        ? selected.verdict
        : !quotaOpen && accounts.verdict === "healthy" && quota.readComplete === true
          ? "healthy"
          : "unknown",
    code: selected.code,
    readComplete:
      selected.verdict === "action" || selected.verdict === "withdraw"
        ? selected.readComplete
        : accounts.readComplete === true,
    poolMembers: accounts.poolMembers,
    poolChecks: accounts.poolChecks,
    poolMissing: accounts.poolMissing,
  };
}
