// A release's database step applies the pool history schema with this migrator. E2E fixtures run
// it on their own isolated database, since no Worker route applies history schema steps.
import { withHistoryDatabase } from "../../src/pool/model-history/database.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";

const connection = process.env.POOL_HISTORY_FIXTURE_DATABASE;
if (!connection) throw new Error("POOL_HISTORY_FIXTURE_DATABASE is required");
try {
  await withHistoryDatabase(connection, migrateModelHistory);
} catch (error) {
  // Driver errors can name the database host; CI logs get only the closed code.
  const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
  console.error(
    `Pool history schema fixture failed: ${/^[A-Z0-9_]{1,32}$/u.test(code) ? code : "unknown"}`,
  );
  process.exitCode = 1;
}
