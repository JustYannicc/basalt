import type { Coverage } from "./steps.ts";

/** Steps the release preflight drives against production-shaped state. Owned by the preflight. */
export const preflightCoverage: readonly Coverage[] = [];
