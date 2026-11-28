import { ControlFailure } from "./json.ts";
import { membershipReadMs, type NativeMembershipPolicy } from "./membership-contract.ts";

/** One Home reference and the saved account the host's last read linked it to. */
export interface MembershipIdentity {
  reference: string;
  account: string;
}

/** What the pool view needs to name each Home account's saved account. */
export interface NativeAccountIdentities {
  readonly native: boolean;
  readonly accounts: readonly { readonly account: string; readonly homeReference: string | null }[];
}

export interface MembershipState extends NativeMembershipPolicy {
  native: boolean;
  /**
   * The last host read's account for each Home reference, for the pool view's annotation. Absent in
   * a state written before it was kept; the view then reads membership from the host as before.
   */
  identities?: MembershipIdentity[];
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
 * A native pool stays due while dirty, so a pending Home binding retries every pass. A host-confirmed
 * non-native pool also stays dirty but waits for the interval: only a reservation can make it native.
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
