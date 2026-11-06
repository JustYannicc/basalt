import { connect, localDatabaseUrl } from "./postgres.ts";

export async function budgetFixture(suffix: string) {
  const direct = localDatabaseUrl(process.env.POOL_TEST_ADMIN_URL);
  const pooled = localDatabaseUrl(process.env.POOL_TEST_POOLED_URL);
  const admin = await connect(direct);
  const consoleUrl = new URL(pooled);
  consoleUrl.pathname = "/pgbouncer";
  const pooler = await connect(consoleUrl);
  const databases = [`budget0314_${suffix}_${process.pid}`];
  for (const role of ["basalt_pool_owner", "budget_a", "budget_b"]) {
    const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
    if (!exists.rowCount)
      await admin.query(
        role === "basalt_pool_owner"
          ? "CREATE ROLE basalt_pool_owner NOLOGIN"
          : `CREATE ROLE ${role} LOGIN PASSWORD 'fixture-only'`,
      );
  }
  await admin.query("GRANT basalt_pool_owner TO budget_a,budget_b WITH INHERIT TRUE, SET TRUE");
  await admin.query(`CREATE DATABASE ${databases[0]} OWNER basalt_pool_owner`);
  return {
    admin,
    pooler,
    direct,
    pooled,
    database: databases[0]!,
    async close() {
      await admin.query(`DROP DATABASE IF EXISTS ${databases[0]} WITH (FORCE)`);
      await pooler.end();
      await admin.end();
    },
  };
}
