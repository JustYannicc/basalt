import type { WorkflowStepContext } from "apps";
import { requirements } from "../common/installation.ts";
import { ReadUnavailable } from "../common/api.ts";
import { readPool } from "../common/reads.ts";
import { poolObservation } from "../common/conditions.ts";
import type { Checkpoint, Observation } from "../common/types.ts";
import { poolAccountsObservation } from "./account-condition.ts";

export async function readPoolStatus(
  ctx: WorkflowStepContext<typeof requirements>,
  app: string,
  provider: string,
  previous: Checkpoint,
): Promise<Observation> {
  const at = Date.now();
  const unknown = {
    cursor: `pool-accounts:${at}`,
    at,
    verdict: "unknown",
    code: "pool-account-read-unavailable",
    failures: 0,
    successes: 0,
    since: at,
  } as const;
  try {
    const fact = await readPool(ctx, app, provider);
    if (fact === null) return unknown;
    if (!fact.owner) return { ...unknown, verdict: "withdraw", code: "not-pool-owner" };
    const quota = poolObservation(fact, previous);
    const accounts = poolAccountsObservation(fact, previous);
    const selected =
      accounts.verdict === "action"
        ? accounts
        : quota.verdict === "action"
          ? quota
          : accounts.verdict === "withdraw"
            ? accounts
            : quota;
    return {
      ...quota,
      cursor: JSON.stringify([quota.cursor, accounts.cursor]),
      verdict:
        selected.verdict === "action" || selected.verdict === "withdraw"
          ? selected.verdict
          : quota.verdict === "healthy" && accounts.verdict === "healthy"
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
  } catch (error) {
    return {
      ...unknown,
      verdict:
        error instanceof ReadUnavailable && [403, 404].includes(error.status)
          ? "withdraw"
          : "unknown",
    };
  }
}
