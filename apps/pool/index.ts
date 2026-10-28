import {
  bearer,
  defineApp,
  defineProvider,
  interactive,
  json,
  mutation,
  number,
  object,
  ProviderError,
  query,
  type ConnectContext,
  type InteractiveMethod,
  type QueryContext,
  router,
  secrets,
  string,
} from "apps";
import { never } from "apps/operations/approval";
import {
  callerHeader,
  controlBasePath,
  type ControlError,
  type ControlErrorCode,
  type LoginFileAdded,
  type PoolView,
  type SignInStarted,
  type SignInStatus,
  type UsageSummary,
} from "./contract.ts";
import { accountStatus, checkFailure } from "./account-status.ts";
import { poolOrigin, productName } from "./deployment.ts";
import { providers } from "./providers.ts";
import { type AccountIdentity, loginFileMethod, prompt, signedIn, withIdentity } from "./sign-in.ts";
import type { Computer, PoolChoice } from "./ui/computer-types.ts";

// The tools service links this account for everyone when it installs a pool.
// Its token works for this one pool only; the pool Worker holds the backend's key.
const pool = defineProvider({
  name: `${productName} pool`,
  hosts: [new URL(poolOrigin).host],
  auth: {
    token: secrets({
      label: "Pool access",
      fields: object({ token: string({ minLength: 1 }) }),
      request: ({ token }) => bearer(token),
    }),
  },
});

// Each subscription the pool serves is an account here, connected from the app's Accounts tab.
// One sign-in method per service the backend signs in, plus pasting a login file.
const subscription = defineProvider({
  name: "Subscription",
  auth: {
    ...Object.fromEntries(providers.map(({ id, name }) => [id, interactive({ label: name })])),
    [loginFileMethod]: interactive({ label: "Login file" }),
  } as Readonly<Record<string, InteractiveMethod>>,
});

const requirements = { app: { accounts: { pool, subscriptions: subscription.many() } } };
type Context = QueryContext<typeof requirements>;
// Connect steps run before every slot is filled, so the pool's own account may be missing there.
type Caller = Context | ConnectContext<typeof requirements>;

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ControlErrorCode; readonly message: string };

async function control<T>(
  ctx: Caller,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Result<T>> {
  const pool = ctx.app.accounts.pool;
  if (!pool) return { ok: false, error: "unauthorized", message: "This pool isn't linked to its access account." };
  const headers: Record<string, string> = { ...pool.headers(), accept: "application/json" };
  // The pool Worker decides what the caller may change. Without a caller, nothing changes.
  const caller = ctx.user?.id;
  if (caller) headers[callerHeader] = caller;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await ctx.fetch(`${poolOrigin}${controlBasePath}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: ctx.signal,
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return { ok: true, value: body as T };
  const failure = body as Partial<ControlError> | undefined;
  if (typeof failure?.error === "string" && typeof failure.message === "string") {
    return { ok: false, error: failure.error, message: failure.message };
  }
  return { ok: false, error: "backend_unavailable", message: "The pool didn't answer. Try again in a moment." };
}

export const view = query(
  { description: "This pool's accounts with their usage windows, and the providers it can connect", input: object({}) },
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
    description: "Tokens and API-equivalent cost through this pool for the last `days` days (1 to 30, default 30), per model and per UTC day. The pool's owner gets the whole pool, each member's totals and cap by tools-service user id, and whether each provider needs an account added or removed. Anyone else gets only their own usage on this pool and their own weekly cap with when it resets.",
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
  /** The owner's link to invite people and remove them. */
  readonly shareHref?: string;
}

export const computerContext = query(
  {
    description: "Your computers in every pool you use, the pools you can pick for each, and short-lived links: `href` sets up this computer or switches a computer's pool in one click, and for the pool's owner `shareHref` invites people to this pool or removes them.",
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
  tools: router({ view, usage, addLoginFile, removeAccount, computerContext }),
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
      // The Accounts tab's plan, availability and usage windows, as the pool last read them.
      check: async (ctx, { ref }) => {
        const result = await control<PoolView>(ctx, "/pool");
        if (!result.ok) throw new ProviderError({ reason: checkFailure(result.error) });
        const account = result.value.accounts.find((candidate) => candidate.id === ref);
        if (!account) throw new ProviderError({ reason: checkFailure("missing") });
        return accountStatus(account, providers);
      },
      // Unlinking or deleting the account removes the subscription from the pool and its backend.
      remove: async (ctx, { ref }) => {
        const result = await control<null>(ctx, `/accounts/${encodeURIComponent(ref)}`, { method: "DELETE" });
        if (!result.ok && result.error !== "not_found") throw new Error(result.message);
      },
    },
  },
});
