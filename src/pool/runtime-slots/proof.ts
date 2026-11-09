import {
  SlotRefused,
  sameIdentity,
  type SlotDriver,
  type SlotHealth,
  type SlotIdentity,
  type SlotSnapshot,
} from "./contract.ts";

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
export function currentPolicies(snapshot: SlotSnapshot, clock: SlotClock) {
  if (snapshot.policies.some((policy) => policy.dirty || policy.expiresAt <= clock.now()))
    throw new SlotRefused("policy");
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
    snapshot.policies.map((policy) => driver.install(identity, policy, AbortSignal.timeout(2_000))),
  );
  const health = healthy(
    await driver.health(identity, AbortSignal.timeout(2_000)),
    identity,
    clock,
  );
  currentPolicies(snapshot, clock);
  return health;
}
