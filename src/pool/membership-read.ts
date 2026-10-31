import { object, text } from "./json.ts";
import { signEnvelope } from "./token.ts";
import { membershipReadPath, membershipReadPrefix, type NativeMembershipSnapshot } from "./membership-contract.ts";

const optionalText = (value: unknown) => value === null || typeof value === "string";

/** The tools service resolves native authority; only this signed private read exposes opaque references. */
export async function readNativeMembership(
  service: { fetch(input: string, init: RequestInit): Promise<Response> },
  signingKey: string,
  pool: string,
  organization: string,
  now = Date.now(),
): Promise<NativeMembershipSnapshot> {
  const envelope = await signEnvelope(signingKey, membershipReadPrefix, {
    pool, organization, at: now, expiresAt: now + 30_000,
  });
  const response = await service.fetch(`https://tools${membershipReadPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Native pool authority is unavailable"); }
  const value: unknown = await response.json();
  if (!object(value) || value.pool !== pool || value.organization !== organization || typeof value.native !== "boolean"
    || !Array.isArray(value.accounts) || value.accounts.length > 2_000
    || !value.accounts.every((account) => object(account) && text(account.account) && text(account.requirement)
      && text(account.provider) && text(account.method) && Number.isSafeInteger(account.generation)
      && Number(account.generation) >= 0 && optionalText(account.driver) && optionalText(account.driverRevision)
      && optionalText(account.bindingRevision) && optionalText(account.homeReference)))
    throw new Error("Native pool authority returned invalid metadata");
  return value as unknown as NativeMembershipSnapshot;
}
