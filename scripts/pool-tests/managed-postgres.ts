import assert from "node:assert/strict";
import type pg from "pg";

/** Match PlanetScale's non-superuser postgres role and a managed migration login. */
export async function managedMigrationUrl(admin: pg.Client, adminUrl: string): Promise<string> {
  const role = await admin.query("SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres'");
  if (!role.rowCount) await admin.query("CREATE ROLE postgres NOLOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT");
  else assert.equal(role.rows[0].rolsuper, false, "The integration fixture must use a non-superuser postgres role");
  const login = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'pool_test_migration'");
  if (!login.rowCount) await admin.query("CREATE ROLE pool_test_migration LOGIN PASSWORD 'fixture-only' IN ROLE postgres");
  const url = new URL(adminUrl);
  url.username = "pool_test_migration";
  url.password = "fixture-only";
  return url.toString();
}
