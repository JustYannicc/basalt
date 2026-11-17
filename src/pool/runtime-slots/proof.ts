import {
  SlotRefused,
  sameIdentity,
  type SlotDriver,
  type SlotHealth,
  type SlotIdentity,
  type SlotSnapshot,
} from "./contract.ts";
import { membershipTtlMs, type NativeMembershipPolicy } from "../membership-contract.ts";

export interface SlotClock {
  now(): number;
  monotonic(): number;
}
export const slotClock: SlotClock = { now: Date.now, monotonic: () => performance.now() };
export function healthy(health: SlotHealth, identity: SlotIdentity, clock: SlotClock) {
  if (!sameIdentity(health.identity, identity)) throw new SlotRefused("identity");
  if (!Number.isFinite(health.policyLeaseUntil) || health.policyLeaseUntil <= clock.monotonic())
    throw new SlotRefused("unhealthy");
  return health;
}
export function retiredDenials(snapshot: SlotSnapshot) {
  if (snapshot.denials.some((policy) => !policy.dirty || policy.accounts.length !== 0))
    throw new SlotRefused("policy");
}
/**
 * A not-ready pool can stay dirty indefinitely. Its veto is per pool (the runtime scheduler and the
 * slot router refuse it), so runtime-wide proofs require only unexpired clean policies and compare
 * the snapshot digest at commit.
 */
export function currentPolicies(snapshot: SlotSnapshot, clock: SlotClock) {
  retiredDenials(snapshot);
  if (snapshot.policies.some((policy) => !policy.dirty && policy.expiresAt <= clock.now()))
    throw new SlotRefused("policy");
}
/** A dirty veto grants nothing, so like a denial it is installed with a fresh lease. */
export function vetoLease(policy: NativeMembershipPolicy, now: number): NativeMembershipPolicy {
  return policy.dirty
    ? { ...policy, expiresAt: Math.max(policy.expiresAt, now + membershipTtlMs) }
    : policy;
}

/** Candidate proofs never use grace or repair Home membership. */
export async function proveSlot(
  driver: SlotDriver,
  identity: SlotIdentity,
  snapshot: SlotSnapshot,
  clock: SlotClock,
) {
  currentPolicies(snapshot, clock);
  healthy(await driver.health(identity, AbortSignal.timeout(2_000)), identity, clock);
  await Promise.all(
    [
      ...snapshot.policies.map((policy) => vetoLease(policy, clock.now())),
      ...snapshot.denials.map((policy) => ({
        ...policy,
        expiresAt: clock.now() + membershipTtlMs,
      })),
    ].map((policy) => driver.install(identity, policy, AbortSignal.timeout(2_000))),
  );
  const health = healthy(
    await driver.health(identity, AbortSignal.timeout(2_000)),
    identity,
    clock,
  );
  currentPolicies(snapshot, clock);
  return health;
}
