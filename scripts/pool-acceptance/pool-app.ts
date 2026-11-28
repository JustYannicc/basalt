/**
 * A pool app's id, the only kind of pool id the tools service makes. Full mode and the load mint an
 * owner token for organization acceptance on such a pool; the tools service's ownership check
 * (carry 0815) refuses that token for any pool the acceptance organization does not own. Kept
 * apart from the shared types, which the fleet lane and the release import.
 */
export const isPoolAppId = (pool: string) => /^app_[A-Za-z0-9_-]{1,124}$/u.test(pool);
