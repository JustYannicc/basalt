import type { Coverage } from "./steps.ts";

/** Steps the release rehearsal drives against production-shaped state. Owned by the rehearsal. */
export const rehearsalCoverage: readonly Coverage[] = [];
