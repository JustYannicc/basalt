import pg from "pg";
import { poolDatabase } from "../src/pool/database-settings.ts";

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const connectionString = process.env.POOL_DATABASE_ADMIN_URL;
const runtimeRole = process.env.POOL_DATABASE_RUNTIME_ROLE;
if (!connectionString || !runtimeRole) throw new Error("Missing pool database provisioning credentials");
const adminUrl = new URL(connectionString);
adminUrl.searchParams.set("options", "-c role=postgres");
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const owner = identifier(poolDatabase.owner);
const database = identifier(poolDatabase.name);
try {
  await admin.connect();
  await admin.query("SELECT pg_advisory_lock(1409, 1)");
  const existingOwner = await admin.query(
    "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [poolDatabase.owner],
  );
  if (!existingOwner.rowCount) {
    await admin.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  } else if (Object.values(existingOwner.rows[0]).some(Boolean)) {
    throw new Error("The pool database owner has unexpected privileges");
  }
  const existingDatabase = await admin.query(
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
    [poolDatabase.name],
  );
  if (!existingDatabase.rowCount) {
    await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
  } else if (existingDatabase.rows[0].owner !== poolDatabase.owner) {
    throw new Error("The pool database has an unexpected owner");
  }
  await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  await admin.query(`GRANT ${owner} TO ${identifier(runtimeRole)}`);
  const scopedUrl = new URL(adminUrl);
  scopedUrl.pathname = `/${poolDatabase.name}`;
  const scoped = new pg.Client({ connectionString: scopedUrl.toString() });
  try {
    await scoped.connect();
    await scoped.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await scoped.query(`GRANT ALL ON SCHEMA public TO ${owner}`);
  } finally {
    await scoped.end();
  }
  console.log("Pool database ready on the existing cluster");
} catch (error) {
  // Driver messages can contain connection details. Keep deploy logs credential-free.
  const code = error instanceof Error && "code" in error && /^[A-Z0-9]{5}$/.test(String(error.code))
    ? ` (${error.code})` : "";
  throw new Error(`Pool database provisioning failed${code}; check the cluster, roles, and database ownership`);
} finally {
  await admin.end();
}
