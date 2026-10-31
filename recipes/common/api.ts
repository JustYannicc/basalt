import { decodeJson, json } from "apps";
import type { WorkflowStepContext, MutationContext } from "apps";
import { configuration } from "./configuration.ts";
import { requirements, origin } from "./installation.ts";

type Context = WorkflowStepContext<typeof requirements> | MutationContext<typeof requirements>;
export class ReadUnavailable extends Error {
  constructor(
    readonly status: number,
    readonly reason?: string,
  ) {
    super("The permitted source request did not succeed.");
  }
}
export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export const list = (value: unknown) => (Array.isArray(value) ? value : []);
export const text = (value: unknown) => (typeof value === "string" ? value : undefined);
export const numeric = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
export const instant = (value: unknown) => {
  const result = typeof value === "string" ? Date.parse(value) : numeric(value);
  return result !== undefined && Number.isFinite(result) ? result : undefined;
};
export function organization(context: Context) {
  const account = context.user.accounts.service;
  const selected =
    account.method === "apiKey" ? account.fields.organization : configuration.organization;
  if (!selected || (configuration.organization && configuration.organization !== selected))
    throw new ReadUnavailable(0);
  return selected;
}
/** Raw responses stay inside a read/send callback, before its allowlisted result is journaled. */
export async function api(
  context: Context,
  method: string,
  path: string,
  input?: unknown,
): Promise<unknown> {
  const account = context.user.accounts.service;
  const token = account.method === "apiKey" ? account.fields.token : account.fields.access_token;
  const headers = new Headers({ authorization: `Bearer ${token}`, accept: "application/json" });
  if (account.method === "apiKey") headers.set("X-Executor-Organization", organization(context));
  if (input !== undefined) headers.set("Content-Type", "application/json");
  const url = new URL(
    `/api/organizations/${encodeURIComponent(organization(context))}/${path}`,
    origin,
  );
  const response = await context.fetch(url, {
    method,
    headers,
    redirect: "manual",
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]),
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  if (!response.ok) {
    let reason: string | undefined;
    try {
      reason = text(record(await response.json())?._tag);
    } catch {
      /* No failure body is retained. */
    }
    throw new ReadUnavailable(response.status, reason);
  }
  return decodeJson(response, json());
}
export function tool(
  context: Context,
  selected: { app: string; tool: string; input: unknown },
  kind: "query" | "mutation" = "query",
) {
  return api(context, "POST", `apps/${encodeURIComponent(selected.app)}/tools/call`, {
    tool: selected.tool,
    kind,
    input: selected.input,
  });
}
