import seed from "../fixtures/seed-2026-11-13.json" with { type: "json" };
import type { PlanAllowanceCatalog } from "../data.ts";
import { PlanAllowances } from "../registry.ts";

/**
 * The allowance table as generated on 13 Nov 2026, frozen. Tests of the pool's logic read this,
 * never the shipped table: each renewal re-dates the shipped rows, so a test clock fixed before a
 * renewal's check date would see its rows as not yet current.
 */
export const seedFixture = seed as PlanAllowanceCatalog;

/** The registry a PoolUsage builds by default, on the frozen table. */
export const fixtureAllowances = (
  storage: ConstructorParameters<typeof PlanAllowances>[0],
  now: () => number,
) => new PlanAllowances(storage, { now, seed: seedFixture });
