import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
/**
 * Every hosted and Cloud step, in the order releases record them. Append only: a new step goes at
 * the end, above every step before it, and a released step never changes its number.
 */
const journals = JSON.parse(
  readFileSync(new URL("./migration-journals.json", import.meta.url), "utf8"),
) as Record<Journal, string[]>;

type Journal = "private_hosted_migrations" | "private_cloud_migrations";

const id = (key: string) => {
  const match = /^(\d+)_[a-z][a-z0-9_]*$/.exec(key);
  if (!match) throw new Error(`Not a migration key: ${key}`);
  return Number(match[1]);
};

/** Every distinct `"<id>_<name>"` migration key in a source. */
export const migrationKeys = (source: string) => [
  ...new Set([...source.matchAll(/"(\d+_[a-z][a-z0-9_]*)"/g)].map((match) => match[1]!)),
];

/**
 * Effect's migrator applies only ids above the highest recorded, and the hosted lineage check
 * refuses a database that recorded a higher id than a pending step. So a step numbered below one
 * a database may already have recorded fails the production migration, and a pin bump that
 * brings an upstream step into a number Basalt's carries use must renumber it past them, as carry
 * 0475 does for upstream's Cloud steps 8 to 13. This catches either before release.
 */
export function migrationNumberProblems(recorded: readonly string[], declared: readonly string[]) {
  const problems: string[] = [];
  const listed = new Set(recorded);
  const current = new Set(declared);
  for (const key of declared)
    if (!listed.has(key)) problems.push(`step ${key} is not in the migration journal record`);
  for (const key of recorded)
    if (!current.has(key))
      problems.push(`recorded step ${key} is no longer declared at its number`);
  for (let index = 1; index < recorded.length; index++)
    if (id(recorded[index]!) <= id(recorded[index - 1]!))
      problems.push(`step ${recorded[index]} is not numbered above ${recorded[index - 1]}`);
  return problems;
}

test("a gap step, a renumbered step or an unlisted step is refused", () => {
  const recorded = ["9_app_account_links", "10_account_observations", "14_v1_session_handoffs"];
  assert.deepEqual(
    migrationNumberProblems(
      [...recorded, "11_group_account_connections"],
      [...recorded, "11_group_account_connections"],
    ),
    ["step 11_group_account_connections is not numbered above 14_v1_session_handoffs"],
  );
  assert.deepEqual(
    migrationNumberProblems(recorded, [
      "9_app_account_links",
      "12_account_observations",
      "14_v1_session_handoffs",
    ]),
    [
      "step 12_account_observations is not in the migration journal record",
      "recorded step 10_account_observations is no longer declared at its number",
    ],
  );
  assert.deepEqual(
    migrationNumberProblems(
      [...recorded, "20_group_account_connections"],
      [...recorded, "20_group_account_connections"],
    ),
    [],
  );
});

for (const [journal, path] of [
  ["private_hosted_migrations", "apps/hosted/server/src/implementation/migrations.ts"],
  ["private_cloud_migrations", "apps/hosted/cloud/src/implementation/migrations.ts"],
] as const)
  test(`${journal}: every declared step is recorded in order above the steps before it`, () => {
    const declared = migrationKeys(readFileSync(`${upstream}/${path}`, "utf8"));
    assert.deepEqual(migrationNumberProblems(journals[journal], declared), []);
  });
