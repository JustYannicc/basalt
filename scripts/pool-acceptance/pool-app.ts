/**
 * A pool app's id, the only kind of pool id the tools service makes. Full mode mints an owner token
 * for organization acceptance on such a pool, and the tools service's ownership check (carry 0815)
 * refuses that token for any pool the acceptance organization does not own; the load mints none and
 * signs only as the test device. Kept apart from the shared types, which the fleet lane and the
 * release import.
 */
export const isPoolAppId = (pool: string) => /^app_[A-Za-z0-9_-]{1,124}$/u.test(pool);
