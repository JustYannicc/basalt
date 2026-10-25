import {
  bearer,
  defineApp,
  defineProvider,
  json,
  mutation,
  number,
  object,
  query,
  type QueryContext,
  router,
  secrets,
  string,
} from "apps";
import { always } from "apps/operations/approval";
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
import { poolOrigin, productName } from "./deployment.ts";
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

const requirements = { app: { accounts: { pool } } };
type Context = QueryContext<typeof requirements>;

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ControlErrorCode; readonly message: string };

async function control<T>(
  ctx: Context,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = { ...ctx.app.accounts.pool.headers(), accept: "application/json" };
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

const sessionFields = { session: string({ minLength: 1 }) };
const session = object(sessionFields);

export const view = query(
  { description: "This pool's accounts with their usage windows, and the providers it can connect", input: object({}) },
  async (ctx: Context) => control<PoolView>(ctx, "/pool"),
);

export const usage = query(
  {
    description: "Tokens and API-equivalent cost through this pool for the last `days` days (1 to 30, default 30), per model and per UTC day. The pool's owner gets the whole pool, each member's totals and cap by tools-service user id, and whether each provider needs an account added or removed. Anyone else gets only their own usage on this pool and their own weekly cap with when it resets.",
    input: object({ days: number().optional() }),
  },
  async (ctx: Context, { days }) => control<UsageSummary>(ctx, `/usage/summary?days=${Math.min(30, Math.max(1, Math.round(days ?? 30)))}`),
);

export const startSignIn = mutation(
  {
    description: "Start connecting a subscription; only the pool's owner can. Give the person `url` to open. With flow `callback`, they sign in and paste back the localhost address the page ends on: pass it to finishSignIn. With flow `device`, they approve on that page (entering `userCode` if set) and the pool finishes by itself. Check signInStatus until it isn't `waiting`. One open sign-in per pool; a new start replaces it.",
    approval: always(),
    input: object({ provider: string({ minLength: 1 }) }),
  },
  async (ctx: Context, { provider }) =>
    control<SignInStarted>(ctx, "/sign-ins", { method: "POST", body: { provider } }),
);

export const finishSignIn = mutation(
  {
    description: "Finish a sign-in with the localhost address the provider's page ended on",
    approval: always(),
    input: object({ ...sessionFields, redirectUrl: string({ minLength: 1 }) }),
  },
  async (ctx: Context, input) => control<SignInStatus>(ctx, "/sign-ins/callback", { method: "POST", body: input }),
);

export const signInStatus = query(
  { description: "Whether a started sign-in has finished: `waiting`, `connected` with the new account, or `failed` with the reason. Polling every few seconds is fine; the pool keeps a sign-in alive while the provider still waits.", input: session },
  async (ctx: Context, input) =>
    control<SignInStatus>(ctx, `/sign-ins/status?session=${encodeURIComponent(input.session)}`),
);

export const cancelSignIn = mutation(
  { description: "Cancel a started sign-in", approval: always(), input: session },
  async (ctx: Context, input) =>
    control<null>(ctx, `/sign-ins?session=${encodeURIComponent(input.session)}`, { method: "DELETE" }),
);

export const addLoginFile = mutation(
  {
    description: "Connect a subscription from a login file the pool backend exported",
    approval: always(),
    input: object({ file: json() }),
  },
  async (ctx: Context, { file }) => control<LoginFileAdded>(ctx, "/login-files", { method: "POST", body: file }),
);

export const removeAccount = mutation(
  { description: "Remove an account from this pool", approval: always(), input: object({ id: string({ minLength: 1 }) }) },
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

export default defineApp(requirements, {
  tools: router({
    view,
    usage,
    startSignIn,
    finishSignIn,
    signInStatus,
    cancelSignIn,
    addLoginFile,
    removeAccount,
    computerContext,
  }),
});
