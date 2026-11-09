import { ControlFailure } from "./json.ts";
import type { NativeMembershipPolicy } from "./membership-contract.ts";

export interface MembershipState extends NativeMembershipPolicy {
  native: boolean;
  checkedAt: number;
  installedRevision: number;
  installedUntil: number;
  installedGraceUntil?: number;
}

export const equalMembershipAccounts = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());

export const membershipPolicy = ({
  pool,
  organization,
  revision,
  expiresAt,
  accounts,
  dirty,
}: MembershipState): NativeMembershipPolicy => ({
  pool,
  organization,
  revision,
  expiresAt,
  accounts,
  dirty,
});

/** Only a clean acknowledgement grants grace. A desired renewal cannot move its deadline. */
export function acknowledgedMembership(policy: MembershipState | undefined, now: number) {
  if (!policy) return undefined;
  if (
    policy.dirty ||
    !policy.native ||
    policy.installedRevision !== policy.revision ||
    (policy.installedGraceUntil ?? policy.installedUntil) <= now
  )
    throw new ControlFailure(503, "backend_unavailable", "Native pool membership is refreshing");
  return membershipPolicy({ ...policy, expiresAt: policy.installedUntil });
}
