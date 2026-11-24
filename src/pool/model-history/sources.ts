/**
 * Every file behind the pool history migrations: the schema module and everything it imports.
 * A check walks those imports and fails when this list and the walk differ.
 */
export const poolMigrationSources = [
  "brand.ts",
  "src/pool/database-settings.ts",
  "src/pool/model-history/bulk-schema.ts",
  "src/pool/model-history/capture-hours-schema.ts",
  "src/pool/model-history/change-journal-schema.ts",
  "src/pool/model-history/change-schema.ts",
  "src/pool/model-history/counter-shape-sql.ts",
  "src/pool/model-history/history-row-schema.ts",
  "src/pool/model-history/import-completion-schema.ts",
  "src/pool/model-history/schema.ts",
  "src/pool/model-history/usage-rollup-people-schema.ts",
  "src/pool/model-history/usage-rollup-schema.ts",
  "src/pool/pool-group.ts",
] as const;

/** Everything the pool database command runs: its three scripts and the migrations above. */
export const poolDatabaseCommandSources = [
  "scripts/ensure-pool-database.ts",
  "scripts/pool-database-ownership.ts",
  "scripts/pool-database-provisioning.ts",
  ...poolMigrationSources,
] as const;

/**
 * The pool database command's key, relative to the directory it runs in. A hand-kept copy of
 * this list once missed the files that hold the migrations' statements, so a release that
 * changed only one of them would have skipped the command. The lockfile that pins the database
 * driver is named here: the planning engine looks for one only upward from the command's
 * directory, and this one sits beside it.
 */
export const poolDatabaseInputs = {
  include: [
    ...poolDatabaseCommandSources.map((path) =>
      path.startsWith("scripts/") ? path.slice("scripts/".length) : `../${path}`,
    ),
    "../.upstream/bun.lock",
  ],
};
