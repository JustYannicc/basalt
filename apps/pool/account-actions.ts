import { mutation, object, query, string, type QueryContext } from "apps";
import { never } from "apps/operations/approval";
import type { Account } from "./contract.ts";
import type { ResetCredits, ResetResult } from "./action-contract.ts";
import { requirements } from "./requirements.ts";
type Context = QueryContext<typeof requirements>;
import { control } from "./control.ts";

const accountInput = object({ id: string({ minLength: 1 }) });
const path = (id: string, action: string) => `/accounts/${encodeURIComponent(id)}/${action}`;

export const refreshUsage = mutation(
  { description: "Read this account's usage now, including idle accounts. The pool owner can force a collection at most once per 30 minutes per account.", approval: never(), input: accountInput },
  async (ctx: Context, { id }) => control<Account>(ctx, path(id, "refresh"), { method: "POST" }),
);
export const pauseAccount = mutation(
  { description: "Pause an account's routing without deleting its sign-in. Only the pool owner can do this.", approval: never(), input: accountInput },
  async (ctx: Context, { id }) => control<{ disabled: boolean }>(ctx, path(id, "pause"), { method: "POST" }),
);
export const resumeAccount = mutation(
  { description: "Resume a paused account. Only the pool owner can do this.", approval: never(), input: accountInput },
  async (ctx: Context, { id }) => control<{ disabled: boolean }>(ctx, path(id, "resume"), { method: "POST" }),
);
export const clearCooldown = mutation(
  { description: "Clear this account's routing cooldown after a quota refusal. Does not reset provider quota or resume a paused account. Only the pool owner can do this.", approval: never(), input: accountInput },
  async (ctx: Context, { id }) => control<{ cleared: boolean }>(ctx, path(id, "cooldown/clear"), { method: "POST" }),
);
export const resetCredits = query(
  { description: "Read current Codex reset credits or Claude reset grants, including IDs, expiry, supported windows and whether Claude permits use now. Only the pool owner can read them.", input: accountInput },
  async (ctx: Context, { id }) => control<ResetCredits>(ctx, path(id, "resets")),
);
export const useReset = mutation(
  {
    description: "Spend the selected banked reset. Read resetCredits first. Supply a fresh UUID requestId for one intended spend and reuse it unchanged for every retry. If the outcome is unknown, never start another spend. Confirmed redemptions retain separate cooldown-cleared and usage-refresh-queued results. Only the pool owner can do this.",
    approval: never(),
    input: object({ id: string({ minLength: 1 }), creditId: string({ minLength: 1 }), requestId: string({ minLength: 1 }) }),
  },
  async (ctx: Context, { id, creditId, requestId }) => control<ResetResult>(ctx, path(id, "resets/use"), {
    method: "POST", body: { creditId, requestId },
  }),
);
