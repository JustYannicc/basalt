import { membershipTtlMs, type NativeMembershipPolicy } from "./membership-contract.ts";

interface AcknowledgedPolicy extends NativeMembershipPolicy {
  native: boolean;
  installedRevision: number;
  installedUntil: number;
  retired?: { resumeAfter: number };
}

/** The membership owner holds its queue until completion persists its receipt. */
export async function proveCurrentMemberships(
  state: Record<string, AcknowledgedPolicy>,
  now: () => number,
  check: (policy: NativeMembershipPolicy) => Promise<void>,
  complete: (assertCurrent: () => void) => Promise<void>,
  deny: (policy: NativeMembershipPolicy) => Promise<void>,
) {
  const assertCurrent = () => {
    if (
      Object.values(state).some((policy) =>
        policy.retired
          ? !policy.dirty || policy.accounts.length !== 0
          : policy.dirty ||
            !policy.native ||
            policy.expiresAt <= now() ||
            policy.installedRevision !== policy.revision ||
            policy.installedUntil <= now(),
      )
    )
      throw new Error("Current native policies are not acknowledged");
  };
  assertCurrent();
  for (const { pool, organization, revision, expiresAt, accounts, dirty, retired } of Object.values(
    state,
  )) {
    const policy = { pool, organization, revision, expiresAt, accounts, dirty };
    // A new boot must acknowledge the denial without turning its durable tombstone into authority.
    if (retired) await deny({ ...policy, expiresAt: now() + membershipTtlMs });
    else await check(policy);
  }
  assertCurrent();
  await complete(assertCurrent);
}
