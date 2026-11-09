import type { NativeMembershipPolicy } from "./membership-contract.ts";

interface AcknowledgedPolicy extends NativeMembershipPolicy {
  native: boolean;
  installedRevision: number;
  installedUntil: number;
}

/** The membership owner holds its queue until completion persists its receipt. */
export async function proveCurrentMemberships(
  state: Record<string, AcknowledgedPolicy>,
  now: () => number,
  check: (policy: NativeMembershipPolicy) => Promise<void>,
  complete: (assertCurrent: () => void) => Promise<void>,
) {
  const assertCurrent = () => {
    if (
      Object.values(state).some(
        (policy) =>
          policy.dirty ||
          !policy.native ||
          policy.expiresAt <= now() ||
          policy.installedRevision !== policy.revision ||
          policy.installedUntil <= now(),
      )
    )
      throw new Error("Current native policies are not acknowledged");
  };
  assertCurrent();
  for (const { pool, organization, revision, expiresAt, accounts, dirty } of Object.values(state))
    await check({ pool, organization, revision, expiresAt, accounts, dirty });
  assertCurrent();
  await complete(assertCurrent);
}
