import { connect, localDatabaseUrl } from "./postgres.ts";

const admin = await connect(localDatabaseUrl(process.env.POOL_TEST_ADMIN_URL));
try {
  const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='basalt_pool_owner'");
  if (!exists.rowCount) await admin.query("CREATE ROLE basalt_pool_owner NOLOGIN");
  for (const role of ["budget_a", "budget_b"]) {
    const found = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
    if (!found.rowCount) await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'fixture-only'`);
  }
  await admin.query("GRANT basalt_pool_owner TO budget_a,budget_b WITH INHERIT TRUE, SET TRUE");
  await admin.query("DROP DATABASE IF EXISTS budget0314_compat WITH (FORCE)");
  if (process.argv[2] !== "cleanup")
    await admin.query("CREATE DATABASE budget0314_compat OWNER basalt_pool_owner");
} finally {
  await admin.end();
}
