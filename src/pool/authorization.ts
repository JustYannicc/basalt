import { callerHeader } from "../../apps/pool/contract.ts";
import { fail } from "./json.ts";
import { verifyPoolToken } from "./token.ts";

export interface PoolPermissions {
  readonly canUse: boolean;
  readonly canManage: boolean;
}

/** Retained bindings keep their original policy until the host authorizes their handoff. */
export async function requirePoolUse(request: Request, input: {
  readonly signingKey: string;
  readonly previousSigningKey?: string;
  readonly permissions: (pool: string, user: string) => Promise<PoolPermissions | undefined>;
}): Promise<void> {
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const claims = bearer ? await verifyPoolToken(input.signingKey, bearer, input.previousSigningKey) : undefined;
  // The endpoint owns its existing missing-token response.
  if (!claims) return;
  const permissions = await input.permissions(claims.pool, request.headers.get(callerHeader) ?? "");
  if (permissions !== undefined && !permissions.canUse)
    fail(403, "unauthorized", "This pool is not available to you.");
}
