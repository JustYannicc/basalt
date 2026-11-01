import {
  defineApp,
  json,
  mutation,
  number,
  object,
  query,
  type ConnectContext,
  type QueryContext,
  router,
  string,
} from "apps";
import { never } from "apps/operations/approval";
import {
  type LoginFileAdded,
  type PoolView,
  type SignInStarted,
  type SignInStatus,
  type UsageSummary,
} from "./contract.ts";
import { checkSubscription } from "./account-observations.ts";
import { providers } from "./providers.ts";
import { type AccountIdentity, loginFileMethod, prompt, signedIn, withIdentity } from "./sign-in.ts";
import { requirements } from "./requirements.ts";
import { control, type Result } from "./control.ts";
export type { Result } from "./control.ts";
import { refreshUsage, pauseAccount, resumeAccount, clearCooldown, resetCredits, useReset } from "./account-actions.ts";
import type { Computer, PoolChoice } from "./ui/computer-types.ts";

type Context = QueryContext<typeof requirements>;
type Caller = Context | ConnectContext<typeof requirements>;

export const view = query(
  { description: "This pool's accounts with their limit windows, reading freshness and banked resets, and the providers it can connect", input: object({}) },
  async (ctx: Context): Promise<Result<PoolView>> => {
    const result = await control<PoolView>(ctx, "/pool");
    if (!result.ok) return result;
    const linked = new Set(ctx.app.accounts.subscriptions.map((account) => account.fields.ref));
    const accounts = result.value.accounts.map((account) => ({ ...account, inAccounts: linked.has(account.id) }));
    return { ok: true, value: { ...result.value, accounts } };
  },
);

export const usage = query(
  {
    description: "Tokens and API-equivalent cost through this pool for the last `days` days (1 to 30, default 30), per model, per UTC day and per serving account. The pool's owner gets the whole pool, each member's totals and cap by tools-service user id, and whether each provider needs an account added or removed. Anyone else gets only their own usage on this pool and their own weekly cap with when it resets.",
    input: object({ days: number().optional() }),
  },
  async (ctx: Context, { days }) => control<UsageSummary>(ctx, `/usage/summary?days=${Math.min(30, Math.max(1, Math.round(days ?? 30)))}`),
);

export const addLoginFile = mutation(
  {
    description: "Connect a subscription from a login file the pool backend exported",
    approval: never(),
    input: object({ file: json() }),
  },
  async (ctx: Context, { file }) => control<LoginFileAdded>(ctx, "/login-files", { method: "POST", body: file }),
);

export const removeAccount = mutation(
  { description: "Remove an account from this pool", approval: never(), input: object({ id: string({ minLength: 1 }) }) },
  async (ctx: Context, { id }) => control<null>(ctx, `/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
);

export interface ComputerContext {
  readonly href: string;
  readonly computers: Computer[];
  readonly pools?: PoolChoice[];
  readonly undoPrompt: string;
  /** Native app settings for a caller who can manage this pool. */
  readonly shareHref?: string;
}

export const computerContext = query(
  {
    description: "Your computers in every pool you use, the pools you can pick for each, and a short-lived setup `href`. If you can manage this pool, `shareHref` opens native app Settings for sharing, per-person usage and caps.",
    input: object({}),
  },
  async (ctx: Context) => control<ComputerContext>(ctx, "/setup-context"),
);

/** A control call that must succeed; the Connect dialog shows the pool's message when it doesn't. */
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** A step's answer: the pool refusing or failing ends the sign-in with its message. */
function step<T>(result: Result<T>, read: (value: T) => ConnectState): ConnectState {
  return result.ok ? read(result.value) : { state: "failed", message: result.message };
}
type ConnectState =
  | ReturnType<typeof signedIn>
  | { state: "connected"; ref: string; accountInfo: AccountIdentity };

/** Name a new subscription after the pool's own label for it, with its provider's logo. */
const identified = (ctx: Caller, state: ConnectState): Promise<ConnectState> =>
  withIdentity(state, () => control<PoolView>(ctx, "/pool"), providers);

const sessionPath = (session: string) => `?session=${encodeURIComponent(session)}`;

export default defineApp(requirements, {
  tools: router({ view, usage, addLoginFile, removeAccount, computerContext, refreshUsage, pauseAccount, resumeAccount, clearCooldown, resetCredits, useReset }),
  // The pool Worker refuses every step unless the caller owns the pool.
  connect: {
    subscriptions: {
      start: async (ctx, { method }) => {
        if (method === loginFileMethod) return prompt.loginFile;
        return prompt.signIn(unwrap(await control<SignInStarted>(ctx, "/sign-ins", { method: "POST", body: { provider: method } })));
      },
      status: async (ctx, { method, session }) =>
        method === loginFileMethod
          ? { state: "waiting" as const }
          : identified(ctx, step(await control<SignInStatus>(ctx, `/sign-ins/status${sessionPath(session)}`), signedIn)),
      submit: async (ctx, { method, session, value: pasted }) => {
        if (method !== loginFileMethod)
          return identified(ctx, step(await control<SignInStatus>(ctx, "/sign-ins/callback", { method: "POST", body: { session, redirectUrl: pasted } }), signedIn));
        let file: unknown;
        try {
          file = JSON.parse(pasted);
        } catch {
          return { state: "failed" as const, message: "That isn't a login file. Paste the whole file's contents." };
        }
        return identified(ctx, step(await control<LoginFileAdded>(ctx, "/login-files", { method: "POST", body: file }), ({ accountId }) => ({
          state: "connected",
          ref: accountId,
        })));
      },
      cancel: async (ctx, { method, session }) => {
        // A sign-in that already ended has nothing to cancel.
        if (method !== loginFileMethod) await control<null>(ctx, `/sign-ins${sessionPath(session)}`, { method: "DELETE" });
      },
      check: (ctx, { ref }) => checkSubscription(ctx, ref),
      // Unlinking or deleting the account removes the subscription from the pool and its backend.
      remove: async (ctx, { ref }) => {
        const result = await control<null>(ctx, `/accounts/${encodeURIComponent(ref)}`, { method: "DELETE" });
        if (!result.ok && result.error !== "not_found") throw new Error(result.message);
      },
    },
  },
});
