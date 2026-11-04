import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyObject } from "../src/pool/model-history/record.ts";
import { historyBackfillPath, historyBackfillVersion, historySchemaApplyPath, historySchemaCatalogPath } from "../src/pool/model-history/operator.ts";

import { historyBaseSchemaVersion, historyAppSchemaVersion, historySchemaVersion, historySchemaStatements, historySchemaMigrations } from "../src/pool/model-history/schema.ts";

type Platform = { env: { POOL_OPERATIONS: { fetch(request: Request): Promise<Response> } }; dispose(): Promise<void> };

export function historyOperatorOptions(args: string[]) {
  const { values } = parseArgs({ args, options: { worker: { type: "string" }, plan: { type: "string" },
    operation: { type: "string" }, apply: { type: "boolean" }, go: { type: "boolean" } } });
  const operation = values.operation ?? "schema";
  if (!values.worker || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.worker) || !values.plan
    || operation !== "schema" && operation !== "backfill" || Boolean(values.apply) !== Boolean(values.go))
    throw new Error("Use --worker <deployed-script> --plan <private-file> [--operation schema|backfill] [--apply --go]");
  return { worker: values.worker, plan: values.plan, operation, apply: values.apply === true } satisfies {
    worker: string; plan: string; operation: "schema" | "backfill"; apply: boolean;
  };
}

function hashes(value: Record<string, unknown>) {
  if (![historyBaseSchemaVersion, historyAppSchemaVersion, historySchemaVersion].includes(String(value.version)) || typeof value.schemaHash !== "string" || !/^[a-f0-9]{64}$/.test(value.schemaHash)
    || typeof value.catalogHash !== "string" || !/^[a-f0-9]{64}$/.test(value.catalogHash)) throw new Error("Invalid history schema plan");
  return { schemaHash: value.schemaHash, catalogHash: value.catalogHash };
}

function schemaPreview(report: Record<string, unknown>) {
  hashes(report);
  const manifest = report.version === historyBaseSchemaVersion ? historySchemaStatements
    : report.version === historyAppSchemaVersion ? historySchemaMigrations.slice(0, 2) : historySchemaMigrations;
  if (report.schemaHash !== createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
    || typeof report.applied !== "boolean") throw new Error("Unknown history schema statements");
  const diff = historyObject(report.catalogDiff);
  if (!Array.isArray(diff.createTables) || !Array.isArray(diff.conflicts) || diff.conflicts.length)
    throw new Error("History schema catalog conflicts");
  const catalog = historyObject(report.catalog);
  if (report.catalogHash !== createHash("sha256").update(JSON.stringify(catalog)).digest("hex"))
    throw new Error("History schema catalog hash changed");
  if (!Array.isArray(catalog.relations)) throw new Error("Invalid history schema catalog");
  const ledgerExists = catalog.relations.some(row => {
    const relation = historyObject(row);
    return relation.name === "basalt_model_history_migrations" && relation.kind === "r";
  });
  // The Worker's ledger bootstrap runs outside the hashed versioned migrations.
  const ledgerDdl = ledgerExists ? [] : [`CREATE TABLE IF NOT EXISTS basalt_model_history_migrations (
      name text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`];
  const pending = report.version === historySchemaVersion ? pendingV3(report)
    : report.applied ? [] : report.version === historyBaseSchemaVersion
    ? [historySchemaMigrations[0]!]
    : diff.createTables.length ? historySchemaMigrations.slice(0, 2) : [historySchemaMigrations[1]!];
  return {
    pendingDdl: [...ledgerDdl, ...pending.flatMap(migration => migration.statements)],
    migrationMarkers: pending.map(migration => ({
      text: "INSERT INTO basalt_model_history_migrations (name) VALUES ($1)", values: [migration.name],
    })),
  };
}

function pendingV3(report: Record<string, unknown>) {
  const names = report.pendingMigrations;
  if (!Array.isArray(names) || names.some((name) => !historySchemaMigrations.some((migration) => migration.name === name))
    || report.applied !== (names.length === 0)) throw new Error("Invalid pending history migrations");
  const pending = historySchemaMigrations.filter((migration) => names.includes(migration.name));
  if (JSON.stringify(names) !== JSON.stringify(pending.map((migration) => migration.name))
    || names.length && names.at(-1) !== historySchemaVersion) throw new Error("Invalid pending history migrations");
  return pending;
}

function approvalFor(operation: "schema" | "backfill", report: Record<string, unknown>) {
  if (operation === "schema") return hashes(report);
  if (report.version !== historyBackfillVersion || typeof report.digest !== "string" || !/^[a-f0-9]{64}$/.test(report.digest))
    throw new Error("Invalid backfill plan");
  return { digest: report.digest, plan: historyObject(report.plan) };
}

/** The deployed Worker retains its database credential; the operator receives catalog facts only. */
export async function runHistoryOperator(options: ReturnType<typeof historyOperatorOptions>, accountId: string,
  connect?: (path: string) => Promise<Platform>) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  let approval: ReturnType<typeof approvalFor> | undefined;
  let approvedSchemaState: string | undefined;
  if (options.apply) {
    const saved = historyObject(JSON.parse(await readFile(options.plan, "utf8")));
    if (saved.accountId !== accountId || saved.worker !== options.worker || saved.operation !== options.operation) throw new Error("History schema plan target changed");
    const report = historyObject(saved.report);
    approval = approvalFor(options.operation, report);
    if (options.operation === "schema") {
      const preview = schemaPreview(report);
      if (JSON.stringify(report.pendingDdl) !== JSON.stringify(preview.pendingDdl)
        || JSON.stringify(report.migrationMarkers) !== JSON.stringify(preview.migrationMarkers))
        throw new Error("History schema statements changed since dry run");
      approvedSchemaState = JSON.stringify({ ...approval, version: report.version, ...preview });
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "pool-history-operator-"));
  const receipt = `${options.plan}.result.json`;
  let platform: Platform | undefined;
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify({ name: "pool-history-operator", account_id: accountId,
      compatibility_date: "2026-09-08", services: [{ binding: "POOL_OPERATIONS", service: options.worker,
        entrypoint: "PoolOperations", remote: true }] }), { mode: 0o600 });
    const open: (configPath: string) => Promise<Platform> = connect ?? (async (configPath: string) => {
      const { getPlatformProxy } = createRequire(new URL("./startup-profiler/package.json", import.meta.url))("wrangler");
      return getPlatformProxy({ configPath, persist: false, remoteBindings: true });
    });
    platform = await open(configPath);
    if (approvedSchemaState) {
      const response = await platform.env.POOL_OPERATIONS.fetch(new Request(`http://pool-operations${historySchemaCatalogPath}`));
      if (!response.ok) throw new Error("History schema catalog refresh failed");
      const current = historyObject(await response.json());
      if (current.status !== "dry-run" || current.writes !== false || current.automaticBackfill !== false
        || JSON.stringify({ ...hashes(current), version: current.version, ...schemaPreview(current) }) !== approvedSchemaState)
        throw new Error("History schema plan changed; prepare and approve a fresh dry run");
    }
    if (approval) await writeFile(receipt, JSON.stringify({ status: "started", accountId, worker: options.worker, ...approval }),
      { mode: 0o600, flag: "wx" });
    const path = options.operation === "backfill" ? historyBackfillPath : approval ? historySchemaApplyPath : historySchemaCatalogPath;
    const response = await platform.env.POOL_OPERATIONS.fetch(new Request(`http://pool-operations${path}`,
      approval ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...approval, go: true }) } : {}));
    if (!response.ok) throw new Error("History operator failed; inspect the private receipt before another apply");
    let report = historyObject(await response.json());
    if (approval) {
      if (report.status !== "complete" || ("schemaHash" in approval
        ? report.schemaHash !== approval.schemaHash || typeof report.applied !== "boolean"
        : report.digest !== approval.digest || report.activated !== true)) throw new Error("Invalid history apply response");
      await writeFile(receipt, JSON.stringify(report), { mode: 0o600 });
    } else {
      approvalFor(options.operation, report);
      if (report.status !== "dry-run" || report.writes !== false || options.operation === "schema" && report.automaticBackfill !== false) throw new Error("Invalid history schema dry run");
      if (options.operation === "schema") report = { ...report, ...schemaPreview(report) };
      await writeFile(options.plan, JSON.stringify({ accountId, worker: options.worker, operation: options.operation, report }), { mode: 0o600, flag: "wx" });
    }
    return report;
  } finally {
    try { await platform?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runHistoryOperator(historyOperatorOptions(process.argv.slice(2)), process.env.CLOUDFLARE_ACCOUNT_ID ?? ""))); }
  catch { console.error("Pool history operator failed. Inspect the private plan and result before retrying."); process.exitCode = 1; }
}
