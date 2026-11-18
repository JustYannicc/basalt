import { BarrierRefusal } from "./refusal.ts";
import type {
  SqlDatabase,
  SqlSchemaExpectation,
  SqlSchemaObservation,
} from "./sql-schema-contract.ts";
import { loadRegistrySqlExpectations } from "./sql-schema-expectations.ts";
import { readSqlObservations, type SqlJournalSource } from "./sql-schema-read.ts";

/**
 * The pre-release twin of the barrier's schema assertion. The release's database phases apply the
 * candidate's registered migrations in order and the barrier then requires all of them, so the
 * live journals must be ready or miss only the candidate's newest entries. Anything else (an
 * unknown or out-of-order marker, a hole, an unreadable journal) would stop the release after its
 * writes began. Home is left out: its target comes from the candidate image the release builds.
 */
export function releaseSchemaApplies(
  expectations: readonly SqlSchemaExpectation[],
  observations: readonly SqlSchemaObservation[],
) {
  const applies: Record<string, readonly string[]> = {};
  for (const expectation of expectations) {
    const entry = observations.find((value) => value.namespace === expectation.namespace);
    const pending = entry?.pending ?? [];
    const tail =
      expectation.kind !== "markers" ||
      pending.every(
        (name, index) =>
          expectation.expected[expectation.expected.length - pending.length + index] === name,
      );
    if (
      !entry ||
      !(entry.status === "ready" || entry.status === "pending") ||
      entry.unexpected?.length !== 0 ||
      !tail
    )
      throw new BarrierRefusal("release-preflight-schema-blocked", `SQL.${expectation.namespace}`);
    applies[expectation.namespace] = pending;
  }
  return applies;
}

export async function releaseSchemaPlan(sources: Record<SqlDatabase, SqlJournalSource>) {
  const expectations = await loadRegistrySqlExpectations();
  const observations: SqlSchemaObservation[] = [];
  for (const database of ["tools", "pool"] as const)
    observations.push(
      ...(await readSqlObservations(
        sources[database],
        expectations.filter((entry) => entry.database === database),
      )),
    );
  return releaseSchemaApplies(expectations, observations);
}
