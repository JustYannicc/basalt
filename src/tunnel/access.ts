import { Schema } from "effect";
import {
  nativeControlPrefix,
  nativeSessionHeader,
  nativeSessionPath,
} from "../pool/native-contract.ts";
import { signEnvelope } from "../pool/token.ts";
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
  const response = await env.TOOLS_SERVICE.fetch(
    new Request(new URL("/api/auth/native/access", request.url), {
      headers: { authorization, accept: "application/json" },
      signal: request.signal,
    }),
  );
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
  return access;
}
export async function tunnelLease(request: Request, env: TunnelEnvironment, access: TunnelAccess) {
  const envelope = await signEnvelope(env.POOL_APP_SIGNING_KEY, nativeControlPrefix, {
    action: "session",
    user: access.userId,
    grant: access.id,
    computer: access.policy.computer,
    pool: access.policy.pool,
    expiresAt: Date.now() + 30_000,
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
