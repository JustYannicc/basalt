import {
  automaticEvidence,
  consumeAutomaticAttempt,
  decodeAutomaticBudget,
  finishAutomaticAttempt,
  type AutomaticBudget,
} from "./automatic-recovery.ts";
import { RecoveryRefused, type AutomaticApproval } from "./recovery-approval.ts";
import { validProbeTarget } from "./availability-config.ts";

export const automaticBudgetKey = "runtime-recovery-v1:automatic-budget";
const budgetKey = automaticBudgetKey;
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: AutomaticBudget): Promise<void>;
}

/** RuntimeRecovery serializes this authority with manual recovery and the lifecycle stop guard. */
export function automaticRecoveryAuthority(
  storage: Storage,
  enabledTarget: string | undefined,
  observe: (pool: string) => Promise<string>,
  now = Date.now,
) {
  return {
    async check(approval: AutomaticApproval) {
      if (!validProbeTarget(enabledTarget) || approval.pool !== enabledTarget)
        throw new RecoveryRefused(403);
      if ((await observe(approval.pool)) !== "view-transport") throw new RecoveryRefused(409);
    },
    async consume(approval: AutomaticApproval) {
      if (
        !/^[a-f0-9]{64}$/.test(approval.selection) ||
        approval.samples.some((s) => s.selection !== approval.selection) ||
        automaticEvidence(approval.samples, now()) !== "eligible"
      )
        throw new RecoveryRefused(409);
      const retained = await storage.get<unknown>(budgetKey);
      let state = retained === undefined ? undefined : decodeAutomaticBudget(retained);
      for (const attempt of state?.attempts ?? []) {
        if (attempt.status !== "started") continue;
        const receipt = await storage.get<{ status?: string }>(
          `runtime-recovery-v1:${attempt.operationId}`,
        );
        if (receipt?.status === "ready" || receipt?.status === "failed")
          state = finishAutomaticAttempt(state, attempt.operationId, receipt.status);
      }
      await storage.put(budgetKey, consumeAutomaticAttempt(state, approval, now()));
    },
    async finish(operationId: string, status: "ready" | "failed") {
      await storage.put(
        budgetKey,
        finishAutomaticAttempt(await storage.get(budgetKey), operationId, status),
      );
    },
  };
}
