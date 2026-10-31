import type pg from "pg";
import { poolDatabase } from "./database-settings.ts";
import { privacyReceipt } from "./privacy-receipt.ts";
import { inventoryFailure, inventoryRecord } from "./inventory-record.ts";
import { poolGroupPrefix } from "./pool-group.ts";

export const inventoryCron = "13 * * * *";
const rowLimit = 1_000;
const byteLimit = 120_000;

// Explicit projections keep credential material and human labels outside the database response.
const projections = {
  credentials: `SELECT uuid, id, "index", provider, disabled, deleted_at IS NOT NULL AS deleted
    FROM auth ORDER BY uuid LIMIT 1001`,
  keys: `SELECT id, user_id, channels, deleted_at IS NOT NULL AS deleted
    FROM api_key ORDER BY id LIMIT 1001`,
  channels: `SELECT id, disabled, deleted_at IS NOT NULL AS deleted,
    CASE WHEN left(channel_name, length($1)) = $1 THEN substring(channel_name FROM length($1) + 1) END AS pool
    FROM channel_group ORDER BY id LIMIT 1001`,
  memberships: `SELECT id, channel_group_id, auth_id, deleted_at IS NOT NULL AS deleted
    FROM channel_group_detail ORDER BY id LIMIT 1001`,
} as const;

function validate(section: string, rows: Record<string, unknown>[]) {
  for (const row of rows) {
    for (const [field, value] of Object.entries(row)) {
      if (field === "channels" && section === "keys") {
        if (value === null) continue;
        if (!Array.isArray(value) || value.length > rowLimit || value.some((item) => !Number.isSafeInteger(item) || item < 0)) {
          throw new Error("Invalid inventory identifiers");
        }
      } else if (field === "disabled" || field === "deleted") {
        if (typeof value !== "boolean") throw new Error("Invalid inventory flag");
      } else if (value !== null && (typeof value !== "string" || value.length > 512)) {
        // pg returns bigint identifiers as decimal strings, without losing precision.
        throw new Error("Invalid inventory identifier");
      }
    }
  }
}

export async function poolInventorySnapshot(client: Pick<pg.Client, "query">) {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '3s'");
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
    const identity = await client.query<{ database: string; read_only: string; snapshot: string }>(
      "SELECT current_database() AS database, current_setting('transaction_read_only') AS read_only, transaction_timestamp()::text AS snapshot",
    );
    if (identity.rows[0]?.database !== poolDatabase.name || identity.rows[0].read_only !== "on") {
      throw new Error("Invalid inventory database");
    }
    const receipt = await privacyReceipt(client);
    const sections: Record<string, Record<string, unknown>[]> = {};
    for (const [section, query] of Object.entries(projections)) {
      const result = await client.query<Record<string, unknown>>(query, section === "channels" ? [poolGroupPrefix] : []);
      if (result.rows.length > rowLimit) throw new Error("Inventory limit exceeded");
      validate(section, result.rows);
      sections[section] = result.rows;
    }
    const report = { snapshot: identity.rows[0].snapshot, receipt, sections };
    if (Buffer.byteLength(JSON.stringify(report)) > byteLimit) throw new Error("Inventory limit exceeded");
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function reportPoolInventory(database: { readonly connectionString: string } | undefined): Promise<void> {
  let client: pg.Client | undefined;
  try {
    const connectionString = database?.connectionString;
    if (!connectionString) throw new Error("Inventory database binding is missing");
    const url = new URL(connectionString);
    // The Hyperdrive resource verifies origin TLS; its Worker-facing URL has no sslmode.
    if (url.pathname !== `/${poolDatabase.name}`) {
      throw new Error("Invalid inventory database");
    }
    const { default: pg } = await import("pg");
    client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 4_000 });
    client.on("error", () => {});
    await client.connect();
    const report = await poolInventorySnapshot(client);
    // These records stay in private Workers observability, outside product telemetry.
    inventoryRecord("pool-v1", report, ["home-credentials", "home-keys", "home-channels", "home-memberships", "schema12-receipt"]);
  } catch {
    inventoryFailure("pool-v1");
  } finally {
    await client?.end().catch(() => {});
  }
}
