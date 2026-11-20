// A release's database step applies the pool history schema with this migrator. E2E fixtures run
// it on their own isolated database, since no Worker route applies history schema steps.
import { withHistoryDatabase } from "../../src/pool/model-history/database.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";

const connection = process.env.POOL_HISTORY_FIXTURE_DATABASE;
if (!connection) throw new Error("POOL_HISTORY_FIXTURE_DATABASE is required");
await withHistoryDatabase(connection, migrateModelHistory);
