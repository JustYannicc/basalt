import { readNativeAuthorization } from "../native-access.ts";
import { Schema } from "effect";
import {
  nativeControlPrefix,
  nativeSessionHeader,
  nativeSessionPath,
} from "../pool/native-contract.ts";
import { hostAssertionTtlMs, signEnvelope } from "../pool/token.ts";
import { upgradedSocket } from "./platform.ts";

export interface TunnelEnvironment {
  TOOLS_SERVICE: { fetch(request: Request): Promise<Response> };
  POOL_SERVICE: { fetch(request: Request): Promise<Response> };
  POOL_APP_SIGNING_KEY: string;
}
const Access = Schema.Struct({
  id: Schema.String.check(Schema.makeFilter((value) => value.startsWith("native:"))),
  userId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  expiresAt: Schema.Int,
  /** When the tools gateway read this answer's rows; a remembered answer predates the call. */
  checkedAt: Schema.optionalKey(Schema.Int),
  policy: Schema.Struct({
    kind: Schema.Literal("native"),
    computer: Schema.NonEmptyString,
    pool: Schema.NonEmptyString,
    models: Schema.Boolean,
    toolsOrganization: Schema.optionalKey(Schema.NonEmptyString),
  }),
});
const readAccess = Schema.decodeUnknownSync(Access);
export type TunnelAccess = typeof Access.Type;
export async function tunnelAccess(request: Request, env: TunnelEnvironment) {
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [^\s]+$/iu.test(authorization))
    return new Response(null, { status: 401 });
  // The earlier of this call's start and the tools gateway's own read, so reuse never extends it.
  const checkedAt = Date.now();
  const response = await readNativeAuthorization(request, env);
  if (!response.ok) {
    await response.body?.cancel();
    return new Response(null, {
      status: [401, 403].includes(response.status) ? response.status : 503,
    });
  }
  const access = readAccess(await response.json());
  if (access.expiresAt <= Date.now()) return new Response(null, { status: 401 });
  if (!access.policy.models && !access.policy.toolsOrganization)
    return new Response(null, { status: 403 });
  return { ...access, checkedAt: Math.min(checkedAt, access.checkedAt ?? checkedAt) };
}
/**
 * A device with models holds its pool's session lease, which ends the tunnel when the pool stops
 * admitting it. A tools-only device holds nothing at the pool: the tools gateway checks its
 * bearer when the tunnel opens and on every tool call, so it takes no lease.
 */
export async function tunnelLease(request: Request, env: TunnelEnvironment, access: TunnelAccess) {
  if (!access.policy.models) return undefined;
  const envelope = await signEnvelope(env.POOL_APP_SIGNING_KEY, nativeControlPrefix, {
    action: "session",
    user: access.userId,
    grant: access.id,
    computer: access.policy.computer,
    pool: access.policy.pool,
    expiresAt: Date.now() + hostAssertionTtlMs,
  });
  const response = await env.POOL_SERVICE.fetch(
    new Request(new URL(nativeSessionPath, request.url), {
      headers: { upgrade: "websocket", [nativeSessionHeader]: envelope },
      signal: request.signal,
    }),
  );
  const socket = response.status === 101 ? upgradedSocket(response) : null;
  if (!socket) {
    await response.body?.cancel();
    throw new Error("Native session is unavailable");
  }
  return socket;
}
