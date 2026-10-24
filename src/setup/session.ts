// What the root pages' hosts share: the tools service's browser session, its native endpoints, and
// signed assertions to the pool controller. Nothing here reads or returns a credential.
import { signEnvelope } from "../pool/token.ts";
import type { ProductEventCallback } from "./product-events.ts";

interface Service { fetch(request: Request): Promise<Response> }
export interface SetupEnv {
  TOOLS_SERVICE: Service;
  POOL_SERVICE: Service;
  POOL_APP_SIGNING_KEY: string;
  onProductEvent?: ProductEventCallback;
}

export const security = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
export class SetupError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function json(value: unknown, status = 200, extra = {}): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { ...security, "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}
export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export function text(value: unknown, max = 8192): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
export async function body(response: Response): Promise<Record<string, unknown>> {
  try { return record(await response.json()); }
  catch { throw new SetupError(502, "Setup service returned an invalid response."); }
}

export async function inputBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 16_384) {
          await reader.cancel();
          throw new SetupError(413, "Setup request is too large.");
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return record(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw new SetupError(400, "Invalid setup request."); }
}

/** Same-origin writes only, as JSON, read with a size limit. */
export async function writeBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new SetupError(403, "Open this from this site's own page.");
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new SetupError(415, "Setup requires JSON.");
  return inputBody(request);
}

/** Cookie authentication stays on the public origin expected by native Better Auth. */
export function native(request: Request, env: SetupEnv, path: string, input?: unknown, method?: string): Promise<Response> {
  const headers = new Headers({ Accept: "application/json" });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("Cookie", cookie);
  if (input !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", new URL(request.url).origin);
  }
  const url = path.startsWith("/") ? path : `/api/auth/${path}`;
  return env.TOOLS_SERVICE.fetch(new Request(new URL(url, request.url), {
    method: method ?? (input === undefined ? "GET" : "POST"), headers, redirect: "manual",
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }));
}
export async function user(request: Request, env: SetupEnv): Promise<string> {
  if (!request.headers.get("cookie")) throw new SetupError(401, "Sign in first.");
  const response = await native(request, env, "get-session?disableCookieCache=true&disableRefresh=true");
  if (!response.ok) throw new SetupError(response.status === 401 ? 401 : 502, "Could not check your session.");
  const session = await body(response);
  const account = record(session.user);
  if (!text(account.id, 512)) throw new SetupError(401, "Sign in first.");
  if (account.emailVerified !== true) throw new SetupError(403, "Verify your email first.");
  return account.id;
}

/**
 * The action binds the signed request to its endpoint; all timestamps are milliseconds. The
 * controller's refusals carry fixed, person-facing messages, so 4xx messages pass through.
 */
export async function pool(request: Request, env: SetupEnv, action: string, payload: Record<string, unknown>): Promise<Response> {
  const envelope = await signEnvelope(env.POOL_APP_SIGNING_KEY, "sbs1", {
    ...payload, action, expiresAt: Date.now() + 30_000,
  });
  const response = await env.POOL_SERVICE.fetch(new Request(new URL(`/__setup/v1/${action}`, request.url), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope }), redirect: "manual",
  }));
  if (!response.ok) {
    const status = [400, 401, 403, 404, 409, 410, 429].includes(response.status) ? response.status : 502;
    const message = status === 502 ? undefined : record(await response.json().catch(() => ({}))).message;
    throw new SetupError(status, action === "claim" ? "Setup link is unavailable. Create a new link."
      : action === "refresh" && status === 409 ? "This link cannot be refreshed. Revoke this computer, then create a new setup."
      : text(message, 300) ? message
      : "Could not complete setup. Try again.");
  }
  return response;
}

export function failure(error: unknown): Response {
  return error instanceof SetupError ? json({ error: error.message }, error.status)
    : json({ error: "This is temporarily unavailable. Try again." }, 502);
}
