import { readNativeAuthorization } from "./native-access.ts";
import { forwardModelCall } from "./model-replay.ts";
import {
  nativeAuthenticationHeader,
  nativeModelHeader,
  nativeModelPrefix,
} from "./pool/native-contract.ts";
export { nativeAuthenticationHeader } from "./pool/native-contract.ts";
import { hostAssertionTtlMs, signEnvelope } from "./pool/token.ts";
import { object, text } from "./pool/json.ts";
import { modelDrainProtocol } from "./pool/model-drain-contract.ts";

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

/**
 * A tunnel operation carries its session's own bearer check. Reusing that answer for this long
 * keeps one check per tunneled request; a later operation on a long session asks again. The pool
 * still checks the device on every model request.
 */
const admissionReuseMs = 3_000;
const recent = (admitted: { readonly checkedAt?: number } | undefined) => {
  const age = admitted?.checkedAt === undefined ? -1 : Date.now() - admitted.checkedAt;
  return age >= 0 && age < admissionReuseMs;
};

/** Authenticate against the tools authority before asserting a device's identity to the pool. */
export async function nativeModelRequest(
  request: Request,
  env: Environment,
  drain = false,
  admitted?: { readonly checkedAt?: number },
): Promise<Response> {
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization?.match(/^Bearer [^\s]+$/iu)) return refused(401);
    let access: unknown = admitted;
    if (!recent(admitted)) {
      const check = await readNativeAuthorization(request, env);
      if (!check.ok) {
        await check.body?.cancel();
        return refused(check.status === 401 || check.status === 403 ? check.status : 503);
      }
      access = await check.json();
    }
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
    const claims = {
      user: access.userId,
      grant: access.id,
      computer: access.policy.computer,
      pool: access.policy.pool,
      method: request.method,
      path: url.pathname + url.search,
      ...(drain ? { modelDrain: modelDrainProtocol } : {}),
    };
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
    // Signed per send: a replay after a long first send needs an assertion that is still live.
    return await forwardModelCall(new Request(request, { headers }), env, async (sent) =>
      sent.set(
        nativeModelHeader,
        await signEnvelope(env.POOL_APP_SIGNING_KEY, nativeModelPrefix, {
          ...claims,
          expiresAt: Date.now() + hostAssertionTtlMs,
        }),
      ),
    );
  } catch {
    return refused(503);
  }
}

/** A direct model call; a send the pool lost is sent again where that is safe (model-replay.ts). */
export function forwardModelRequest(
  request: Request,
  env: Pick<Environment, "POOL_SERVICE" | "POOL_APP_SIGNING_KEY">,
): Promise<Response> {
  return forwardModelCall(request, env);
}
