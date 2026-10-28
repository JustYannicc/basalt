import pg from "pg";
import { clientConfig, provisionPoolDatabase } from "./pool-database-provisioning.ts";

const adminUrl = process.env.POOL_DATABASE_ADMIN_URL;
const runtimeLogin = process.env.POOL_DATABASE_RUNTIME_ROLE;
if (!adminUrl || !runtimeLogin) throw new Error("Missing pool database provisioning credentials");
try {
  await provisionPoolDatabase({
    runtimeLogin,
    connect: async (database) => {
      const client = new pg.Client(clientConfig(adminUrl, database));
      // A dropped idle session surfaces through its next query; an unhandled 'error' event would crash.
      client.on("error", () => {});
      await client.connect();
      return client;
    },
  });
  console.log("Pool database ready on the existing cluster");
} catch (error) {
  // Messages come from provisionPoolDatabase, which never includes driver text or connection details.
  console.error(error instanceof Error ? error.message : "Pool database provisioning failed");
  process.exitCode = 1;
}
// An abandoned attempt's socket must not hold the deploy until Alchemy's timeout.
process.exit();
