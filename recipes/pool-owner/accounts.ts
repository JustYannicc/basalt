import type { WorkflowStepContext } from "apps";
import { requirements } from "../common/installation.ts";
import { ReadUnavailable } from "../common/api.ts";
import { readPool } from "../common/reads.ts";
import type { Checkpoint, Observation } from "../common/types.ts";
import { poolStatusObservation } from "./pool-condition.ts";

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
    return poolStatusObservation(fact, previous);
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
