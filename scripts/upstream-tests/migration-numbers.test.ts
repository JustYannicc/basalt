import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
/** Steps a production database may already have recorded, as released before this candidate. */
const released = JSON.parse(
  readFileSync(new URL("./released-migration-journals.json", import.meta.url), "utf8"),
) as Record<Journal, string[]>;

type Journal = "private_hosted_migrations" | "private_cloud_migrations";
type Step = { id: number; name: string };

const step = (key: string): Step => {
  const match = /^(\d+)_([a-z][a-z0-9_]*)$/.exec(key);
  if (!match) throw new Error(`Not a migration key: ${key}`);
  return { id: Number(match[1]), name: match[2]! };
};

/** Every distinct `"<id>_<name>"` migration key in a source. */
export const migrationKeys = (source: string) => [
  ...new Set([...source.matchAll(/"(\d+_[a-z][a-z0-9_]*)"/g)].map((match) => match[1]!)),
];

/**
 * Effect's migrator records each applied id and applies only ids above the highest recorded, so a
 * step numbered at or below a released one is skipped silently on every existing database. A pin
 * bump that brings an upstream step into a number Basalt's carries already use must renumber it
 * past the released steps, as carry 0475 does for upstream's Cloud steps 8 to 13.
 */
export function migrationNumberProblems(releasedKeys: readonly string[], declared: readonly string[]) {
  const problems: string[] = [];
  const current = new Set(declared);
  for (const key of releasedKeys)
    if (!current.has(key)) problems.push(`released step ${key} is no longer declared at its number`);
  const highest = Math.max(0, ...releasedKeys.map((key) => step(key).id));
  const releasedSet = new Set(releasedKeys);
  for (const key of declared)
    if (!releasedSet.has(key) && step(key).id <= highest)
      problems.push(`new step ${key} is numbered at or below released step ${highest}`);
  const ids = new Map<number, string>();
  for (const key of declared) {
    const other = ids.get(step(key).id);
    if (other !== undefined) problems.push(`steps ${other} and ${key} share an id`);
    else ids.set(step(key).id, key);
  }
  return problems;
}

test("a new step below a released one, a renumbered release, or a reused id is refused", () => {
  const releasedKeys = ["9_app_account_links", "10_account_observations", "23_account_traffic_changes"];
  assert.deepEqual(
    migrationNumberProblems(releasedKeys, [...releasedKeys, "10_group_account_connections"]),
    [
      "new step 10_group_account_connections is numbered at or below released step 23",
      "steps 10_account_observations and 10_group_account_connections share an id",
    ],
  );
  assert.deepEqual(
    migrationNumberProblems(releasedKeys, ["9_app_account_links", "13_account_observations", "23_account_traffic_changes"]),
    [
      "released step 10_account_observations is no longer declared at its number",
      "new step 13_account_observations is numbered at or below released step 23",
    ],
  );
  assert.deepEqual(
    migrationNumberProblems(releasedKeys, [...releasedKeys, "25_group_account_connections"]),
    [],
  );
});

for (const [journal, path] of [
  ["private_hosted_migrations", "apps/hosted/server/src/implementation/migrations.ts"],
  ["private_cloud_migrations", "apps/hosted/cloud/src/implementation/migrations.ts"],
] as const)
  test(`${journal}: every new step at this pin runs on a database that ran the released ones`, () => {
    const declared = migrationKeys(readFileSync(`${upstream}/${path}`, "utf8"));
    assert.deepEqual(migrationNumberProblems(released[journal], declared), []);
  });
