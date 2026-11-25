import assert from "node:assert/strict";
import type pg from "pg";

/**
 * Match PlanetScale's non-superuser postgres role. Every file that needs it calls this itself: test
 * files run in any order and in separate legs, so none may rely on another file having created it.
 */
export async function ensurePostgresRole(admin: pg.Client): Promise<void> {
  const role = await admin.query("SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres'");
  if (!role.rowCount)
    await admin.query("CREATE ROLE postgres NOLOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT");
  else
    assert.equal(
      role.rows[0].rolsuper,
      false,
      "The integration fixture must use a non-superuser postgres role",
    );
}

/**
 * Let the postgres role administer `role` when it already exists. Proofs that create it as the
 * fixture superuser leave postgres unable to grant it or own a database as it, and any of them may
 * have run first; a role postgres creates itself it already administers.
 */
export async function ensurePostgresAdministers(admin: pg.Client, role: string): Promise<void> {
  const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (existing.rowCount)
    await admin.query(
      `GRANT "${role.replaceAll('"', '""')}" TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`,
    );
}

/** Match PlanetScale's non-superuser postgres role and a managed migration login. */
export async function managedMigrationUrl(admin: pg.Client, adminUrl: string): Promise<string> {
  await ensurePostgresRole(admin);
  await ensurePostgresAdministers(admin, "basalt_pool_owner");
  const login = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'pool_test_migration'");
  if (!login.rowCount)
    await admin.query(
      "CREATE ROLE pool_test_migration LOGIN PASSWORD 'fixture-only' IN ROLE postgres",
    );
  const url = new URL(adminUrl);
  url.username = "pool_test_migration";
  url.password = "fixture-only";
  return url.toString();
}
