import { upstreamOutcomeUnknown } from "../clients/contracts/model-error.ts";
import {
  nativeAuthenticationHeader,
  nativeModelHeader,
  nativeModelPrefix,
} from "./pool/native-contract.ts";
export { nativeAuthenticationHeader } from "./pool/native-contract.ts";
import { signEnvelope } from "./pool/token.ts";
import { object, text } from "./pool/json.ts";

interface Environment {
  TOOLS_SERVICE: { fetch(request: Request): Promise<Response> };
  POOL_SERVICE: { fetch(request: Request): Promise<Response> };
  POOL_APP_SIGNING_KEY: string;
}
const refused = (status: number) =>
  Response.json(
    { error: "Native access is unavailable. Sign in again or retry." },
    { status, headers: { "cache-control": "no-store" } },
  );

/** Authenticate against the tools authority before asserting a device's identity to the pool. */
export async function nativeModelRequest(request: Request, env: Environment): Promise<Response> {
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization?.match(/^Bearer [^\s]+$/iu)) return refused(401);
    const check = await env.TOOLS_SERVICE.fetch(
      new Request(new URL("/api/auth/native/access", request.url), {
        headers: { authorization, accept: "application/json" },
        signal: request.signal,
      }),
    );
    if (!check.ok) {
      await check.body?.cancel();
      return refused(check.status === 401 || check.status === 403 ? check.status : 503);
    }
    const access: unknown = await check.json();
    if (
      !object(access) ||
      !text(access.id)?.startsWith("native:") ||
      !text(access.userId) ||
      !object(access.policy) ||
      access.policy.kind !== "native" ||
      !text(access.policy.computer) ||
      !text(access.policy.pool)
    )
      return refused(503);
    if (access.policy.models !== true) return refused(403);
    const url = new URL(request.url);
    const assertion = await signEnvelope(env.POOL_APP_SIGNING_KEY, nativeModelPrefix, {
      user: access.userId,
      grant: access.id,
      computer: access.policy.computer,
      pool: access.policy.pool,
      method: request.method,
      path: url.pathname + url.search,
      expiresAt: Date.now() + 30_000,
    });
    const headers = new Headers(request.headers);
    for (const name of [
      nativeAuthenticationHeader,
      "authorization",
      "cookie",
      "x-api-key",
      "x-goog-api-key",
      nativeModelHeader,
    ])
      headers.delete(name);
    headers.set(nativeModelHeader, assertion);
    return forwardModelRequest(new Request(request, { headers }), env);
  } catch {
    return refused(503);
  }
}

/** Once a binding send starts, a rejected promise leaves the upstream outcome unknown. */
export async function forwardModelRequest(request: Request, env: Pick<Environment, "POOL_SERVICE">): Promise<Response> {
  try { return await env.POOL_SERVICE.fetch(request); }
  catch { return upstreamOutcomeUnknown(); }
}
