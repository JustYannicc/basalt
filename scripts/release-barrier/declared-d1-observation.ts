import type { Database } from "alchemy/Cloudflare/D1";
import { BarrierRefusal, digest } from "./manifest.ts";
import { d1Mismatch } from "./declared-d1-types.ts";
import type { PreparedD1 } from "./declared-d1-types.ts";

export function assertD1Observation(
  database: Pick<PreparedD1, "fqn" | "target" | "databaseId">,
  observed: Database["Attributes"] | undefined,
) {
  if (!observed)
    throw new BarrierRefusal("declared-prerequisite-missing", database.fqn, {
      fqn: database.fqn,
      type: "Cloudflare.D1Database",
      changed: [{ path: "$resource", old: "created", new: null }],
    });
  const expected = {
    accountHash: digest(database.target.accountId),
    nameHash: digest(database.target.databaseName),
    databaseIdHash: database.databaseId ? digest(database.databaseId) : null,
    jurisdiction: "eu",
    readReplication: "disabled",
    migrationsDir: false,
    migrationsTable: false,
    migrations: 0,
    imports: 0,
  };
  const actual = {
    accountHash: digest(observed.accountId),
    nameHash: digest(observed.databaseName),
    databaseIdHash: digest(observed.databaseId),
    jurisdiction: observed.jurisdiction,
    readReplication: observed.readReplication?.mode ?? "disabled",
    migrationsDir: observed.migrationsDir !== undefined,
    migrationsTable: observed.migrationsTable !== undefined,
    migrations: Object.keys(observed.migrationsHashes).length,
    imports: Object.keys(observed.importHashes).length,
  };
  const mismatch = d1Mismatch("declared-d1-observation-mismatch", database.fqn, expected, actual);
  if (mismatch.delta?.changed.length) throw mismatch;
  return observed;
}
