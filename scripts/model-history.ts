import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { poolDatabase } from "../src/pool/database-settings.ts";
import { activateHomeBackfill, planHomeBackfill, type BackfillPlan } from "../src/pool/model-history/activation.ts";
import { captureHomeRequests } from "../src/pool/model-history/capture.ts";
import { historySchemaStatements, historySchemaVersion, migrateModelHistory, planModelHistorySchema } from "../src/pool/model-history/schema.ts";

const [command, mode, path, approval] = process.argv.slice(2);
const schemaHash = createHash("sha256").update(JSON.stringify(historySchemaStatements)).digest("hex");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function main() {
  if (command === "schema" && mode === "--dry-run") {
    let catalog: unknown;
    const connectionString = process.env.POOL_HISTORY_DATABASE_URL;
    if (connectionString) {
      if (new URL(connectionString).pathname !== `/${poolDatabase.name}`) throw new Error("Invalid history database");
      const db = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 4_000 });
      db.on("error", () => {});
      try { await db.connect(); catalog = await planModelHistorySchema(db); }
      finally { await db.end().catch(() => {}); }
    }
    console.log(JSON.stringify({ version: historySchemaVersion, sha256: schemaHash, additive: true,
      existingTableWrites: false, automaticBackfill: false, catalog, statements: historySchemaStatements }, null, 2));
    return;
  }
  const valid = command === "schema" && mode === "--apply" && path === schemaHash
    || command === "backfill" && mode === "--dry-run" && path && !approval
    || command === "backfill" && mode === "--activate" && path && /^[a-f0-9]{64}$/.test(approval ?? "")
    || command === "capture" && mode === "--step" && path === "approved-active-cursor";
  if (!valid) throw new Error("Use schema --dry-run, schema --apply <sha256>, backfill --dry-run <report>, backfill --activate <report> <sha256>, or capture --step approved-active-cursor");
  const connectionString = process.env.POOL_HISTORY_DATABASE_URL;
  if (!connectionString || new URL(connectionString).pathname !== `/${poolDatabase.name}`)
    throw new Error("POOL_HISTORY_DATABASE_URL must select the pool database");
  // Credentials arrive through the existing secure environment/file flow, never argv or reports.
  const db = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 6_000 });
  db.on("error", () => {});
  try {
    await db.connect();
    if (command === "schema") {
      await migrateModelHistory(db);
      console.log(JSON.stringify({ version: historySchemaVersion, applied: true }));
    } else if (command === "backfill" && mode === "--dry-run") {
      const plan = await planHomeBackfill(db);
      await writeFile(path!, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      console.log(JSON.stringify({ ...plan, sha256: hash(plan), writes: false }));
    } else if (command === "backfill") {
      const plan: BackfillPlan = JSON.parse(await readFile(path!, "utf8"));
      if (hash(plan) !== approval) throw new Error("Backfill report approval does not match");
      await activateHomeBackfill(db, plan);
      console.log(JSON.stringify({ activated: true, through: plan.upperId, rows: plan.rows }));
    } else {
      console.log(JSON.stringify(await captureHomeRequests(db)));
    }
  } finally { await db.end().catch(() => {}); }
}

try { await main(); }
catch {
  console.error("Model history operation failed; no driver or export text is recorded");
  process.exitCode = 1;
}
