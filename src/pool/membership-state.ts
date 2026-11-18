import { ControlFailure } from "./json.ts";
import { membershipReadMs, type NativeMembershipPolicy } from "./membership-contract.ts";

export interface MembershipState extends NativeMembershipPolicy {
  native: boolean;
  nativeConfirmed?: boolean;
  checkedAt: number;
  installedRevision: number;
  installedUntil: number;
  installedGraceUntil?: number;
  retiredAt?: number;
  retired?: { resumeAfter: number };
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

/**
 * A pass reads the host after a reservation, an unacknowledged revision or a failure, on a
 * controller's first pass, and otherwise once per read interval. A host-confirmed non-native pool
 * stays dirty but waits for the interval: only a reservation can make it native.
 */
export const membershipReadDue = (
  policy: MembershipState,
  readAt: number | undefined,
  failed: boolean,
  now: number,
) =>
  readAt === undefined ||
  failed ||
  (policy.dirty && policy.native) ||
  policy.installedRevision !== policy.revision ||
  now - readAt >= membershipReadMs;

/** Only a clean acknowledgement grants grace. A desired renewal cannot move its deadline. */
export function acknowledgedMembership(policy: MembershipState | undefined, now: number) {
  if (!policy) return undefined;
  if (
    policy.retired ||
    policy.dirty ||
    !policy.native ||
    policy.installedRevision !== policy.revision ||
    (policy.installedGraceUntil ?? policy.installedUntil) <= now
  )
    throw new ControlFailure(503, "backend_unavailable", "Native pool membership is refreshing");
  return membershipPolicy({ ...policy, expiresAt: policy.installedUntil });
}
