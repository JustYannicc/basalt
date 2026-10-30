import type { QueryContext, ConnectContext } from "apps";
import { requirements } from "./requirements.ts";
type Caller = QueryContext<typeof requirements> | ConnectContext<typeof requirements>;
import { callerHeader, controlBasePath, type ControlError, type ControlErrorCode } from "./contract.ts";
import { poolOrigin } from "./deployment.ts";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ControlErrorCode; readonly message: string };

export async function control<T>(
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

