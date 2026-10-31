import { digest } from "./backend-users.ts";
import { modelKeyScope } from "./key-scope.ts";
import { policyHeader, policyUsePrefix } from "./membership-contract.ts";
import { NativeMemberships } from "./membership.ts";
import type { RefusalIdentity } from "./gateway-failure.ts";
import { signEnvelope } from "./token.ts";

interface NativeIdentity { pool: string; person: string; keyId?: number }
export class ModelMembershipUnavailable extends Error {
  readonly identity?: RefusalIdentity;
  constructor(identity?: RefusalIdentity) {
    super("Native pool authority is unavailable");
    this.identity = identity;
  }
}

/** Only verified key scope selects a pool. Request headers cannot select native authority. */
export async function modelMembership(
  request: Request,
  memberships: NativeMemberships,
  signingKey: string,
  connectionString: string | undefined,
  native?: NativeIdentity,
): Promise<{ request: Request; identity?: RefusalIdentity; pool?: string }> {
  const headers = new Headers(request.headers);
  headers.delete(policyHeader);
  const cleaned = new Request(request, { headers });
  if (!await memberships.configured()) return { request: cleaned };
  const scope = native === undefined ? await modelKeyScope(connectionString, cleaned) : undefined;
  const pool = native?.pool ?? (scope?.pools.length === 1 && !scope.unrestricted ? scope.pools[0] : undefined);
  if (!pool) throw new ModelMembershipUnavailable();
  const identity: RefusalIdentity = {
    pool, person: native ? await digest(native.person) : scope?.person ?? null,
    ...(native?.keyId ?? scope?.keyId ? { keyId: native?.keyId ?? scope?.keyId } : {}),
  };
  const policy = await memberships.authority(pool).catch(() => { throw new ModelMembershipUnavailable(identity); });
  if (policy) {
    headers.set(policyHeader, await signEnvelope(signingKey, policyUsePrefix, {
      pool, revision: policy.revision, expiresAt: Date.now() + 2 * 60 * 60_000,
    }));
  }
  return { request: new Request(request, { headers }), identity, pool };
}
