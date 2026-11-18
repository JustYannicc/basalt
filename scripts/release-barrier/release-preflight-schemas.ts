import { setTimeout as delay } from "node:timers/promises";
import { BarrierRefusal } from "./refusal.ts";
import type {
  SqlDatabase,
  SqlSchemaExpectation,
  SqlSchemaObservation,
} from "./sql-schema-contract.ts";
import { loadRegistrySqlExpectations } from "./sql-schema-expectations.ts";
import { readSqlObservations, type SqlJournalSource } from "./sql-schema-read.ts";

// Effect's Migrator runs only ids above the journal's latest, so a missing lower id is never applied.
const idOrdered = new Set<SqlSchemaExpectation["namespace"]>(["hosted", "cloud"]);
const markerId = (marker: string) => Number(/^(\d+)_/.exec(marker)?.[1] ?? Number.NaN);

/**
 * The pre-release twin of the barrier's schema assertion. The release's database phases apply the
 * candidate's registered migrations and the barrier then requires all of them, so each journal
 * must be one those phases bring to ready. Refusing anything they would migrate blocks a working
 * release, so this follows each migrator's own rule: model history applies every missing name,
 * the product journals only ids above their latest. Home is left out: its target comes from the
 * candidate image the release builds.
 */
export function releaseSchemaApplies(
  expectations: readonly SqlSchemaExpectation[],
  observations: readonly SqlSchemaObservation[],
) {
  const applies: Record<string, readonly string[]> = {};
  for (const expectation of expectations) {
    const field = `SQL.${expectation.namespace}`;
    const entry = observations.find((value) => value.namespace === expectation.namespace);
    if (!entry || entry.status === "unreadable" || !entry.pending || !entry.applied)
      throw new BarrierRefusal(
        `release-preflight-schema-unreadable-${entry?.reason ?? "missing"}`,
        field,
      );
    if (entry.status === "incompatible" || entry.unexpected?.length !== 0)
      throw new BarrierRefusal("release-preflight-schema-unexpected", field);
    const latest = Math.max(0, ...entry.applied.map(markerId));
    if (
      idOrdered.has(expectation.namespace) &&
      entry.pending.some((marker) => !(markerId(marker) > latest))
    )
      throw new BarrierRefusal("release-preflight-schema-out-of-order", field);
    applies[expectation.namespace] = entry.pending;
  }
  return applies;
}

const transient = (entry: SqlSchemaObservation) =>
  entry.reason === "connection" || entry.reason === "query";

export async function releaseSchemaPlan(sources: Record<SqlDatabase, SqlJournalSource>) {
  const expectations = await loadRegistrySqlExpectations();
  const observations: SqlSchemaObservation[] = [];
  for (const database of ["tools", "pool"] as const) {
    const read = () =>
      readSqlObservations(
        sources[database],
        expectations.filter((entry) => entry.database === database),
      );
    let observed = await read();
    // A release's migration lock or a dropped connection outlasts the 500 ms lock timeout once.
    if (observed.some(transient)) {
      await delay(2_000);
      observed = await read();
    }
    observations.push(...observed);
  }
  return releaseSchemaApplies(expectations, observations);
}
