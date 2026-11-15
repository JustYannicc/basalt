import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyObject } from "../src/pool/model-history/record.ts";
import {
  HistoryOperatorFailure,
  historyOperatorStep,
  type HistoryOperatorField,
} from "./pool-history-operator-failure.ts";
import {
  historyJournalActivationPath,
  historyJournalActivationManifest,
  historyJournalReaderVersion,
  historyBackfillPath,
  historyBackfillVersion,
  historySchemaApplyPath,
  historySchemaCatalogPath,
} from "../src/pool/model-history/operator.ts";

import {
  historyJournalActivationMigration,
  historyBaseSchemaVersion,
  historySchemaStatements,
  historySchemaMigrations,
} from "../src/pool/model-history/schema.ts";

type Platform = {
  env: { POOL_OPERATIONS: { fetch(request: Request): Promise<Response> } };
  dispose(): Promise<void>;
};

export function historyOperatorOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      worker: { type: "string" },
      plan: { type: "string" },
      operation: { type: "string" },
      apply: { type: "boolean" },
      go: { type: "boolean" },
      "readers-ready": { type: "string" },
    },
  });
  const operation = values.operation ?? "schema";
  if (
    !values.worker ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.worker) ||
    !values.plan ||
    (operation !== "schema" && operation !== "backfill" && operation !== "journal-activation") ||
    (values["readers-ready"] !== undefined &&
      (operation !== "journal-activation" ||
        values["readers-ready"] !== historyJournalReaderVersion)) ||
    (operation === "journal-activation" &&
      values.apply === true &&
      values["readers-ready"] !== historyJournalReaderVersion) ||
    Boolean(values.apply) !== Boolean(values.go)
  )
    throw new Error(
      "Use --worker <deployed-script> --plan <private-file> [--operation schema|backfill|journal-activation] [--apply --go] [--readers-ready checkpoint-count-v1]",
    );
  return {
    worker: values.worker,
    plan: values.plan,
    operation,
    apply: values.apply === true,
    readersReady: values["readers-ready"],
  } satisfies {
    worker: string;
    plan: string;
    operation: "schema" | "backfill" | "journal-activation";
    apply: boolean;
    readersReady?: string;
  };
}

function hashes(value: Record<string, unknown>) {
  if (
    ![...historySchemaMigrations, historyJournalActivationMigration].some(
      (migration) => migration.name === String(value.version),
    )
  )
    throw new HistoryOperatorFailure("report.version");
  if (typeof value.schemaHash !== "string" || !/^[a-f0-9]{64}$/.test(value.schemaHash))
    throw new HistoryOperatorFailure("report.schemaHash");
  if (typeof value.catalogHash !== "string" || !/^[a-f0-9]{64}$/.test(value.catalogHash))
    throw new HistoryOperatorFailure("report.catalogHash");
  return { schemaHash: value.schemaHash, catalogHash: value.catalogHash };
}

function schemaPrefix(version: string) {
  if (version === historyJournalActivationMigration.name)
    return {
      migrations: [historyJournalActivationMigration],
      manifest: historyJournalActivationManifest,
    };
  const end = historySchemaMigrations.findIndex((migration) => migration.name === version);
  if (end < 0) throw new HistoryOperatorFailure("report.version");
  const migrations = historySchemaMigrations.slice(0, end + 1);
  return {
    migrations,
    // v1 plans used the statements array directly; keep that historical hash stable.
    manifest: version === historyBaseSchemaVersion ? historySchemaStatements : migrations,
  };
}

function reportObject(value: unknown, field: HistoryOperatorField) {
  try {
    return historyObject(value);
  } catch {
    throw new HistoryOperatorFailure(field);
  }
}

function schemaPreview(
  report: Record<string, unknown>,
  operation: "schema" | "journal-activation",
) {
  const activation = operation === "journal-activation";
  if (activation !== (report.version === historyJournalActivationMigration.name))
    throw new HistoryOperatorFailure("report.version");
  if (activation && report.readersReadyRequired !== historyJournalReaderVersion)
    throw new HistoryOperatorFailure("report.readersReadyRequired");
  hashes(report);
  const { manifest, migrations } = schemaPrefix(String(report.version));
  if (report.schemaHash !== createHash("sha256").update(JSON.stringify(manifest)).digest("hex"))
    throw new HistoryOperatorFailure("report.schemaHash");
  if (typeof report.applied !== "boolean") throw new HistoryOperatorFailure("report.applied");
  const diff = reportObject(report.catalogDiff, "report.catalogDiff");
  if (!Array.isArray(diff.createTables))
    throw new HistoryOperatorFailure("report.catalogDiff.createTables");
  if (!Array.isArray(diff.conflicts) || diff.conflicts.length)
    throw new HistoryOperatorFailure("report.catalogDiff.conflicts");
  const catalog = reportObject(report.catalog, "report.catalog");
  if (report.catalogHash !== createHash("sha256").update(JSON.stringify(catalog)).digest("hex"))
    throw new HistoryOperatorFailure("report.catalogHash");
  if (!Array.isArray(catalog.relations))
    throw new HistoryOperatorFailure("report.catalog.relations");
  const ledgerExists = catalog.relations
    .map((row) => reportObject(row, "report.catalog.relations"))
    .some(
      (relation) => relation.name === "basalt_model_history_migrations" && relation.kind === "r",
    );
  // The Worker's ledger bootstrap runs outside the hashed versioned migrations.
  const ledgerDdl = ledgerExists
    ? []
    : [
        `CREATE TABLE IF NOT EXISTS basalt_model_history_migrations (
      name text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      ];
  const pending =
    activation || migrations.length >= 3
      ? pendingMigrations(report, migrations)
      : report.applied
        ? []
        : report.version === historyBaseSchemaVersion
          ? [historySchemaMigrations[0]!]
          : diff.createTables.length
            ? historySchemaMigrations.slice(0, 2)
            : [historySchemaMigrations[1]!];
  return {
    pendingDdl: [...ledgerDdl, ...pending.flatMap((migration) => migration.statements)],
    migrationMarkers: pending.map((migration) => ({
      text: "INSERT INTO basalt_model_history_migrations (name) VALUES ($1)",
      values: [migration.name],
    })),
  };
}

function pendingMigrations(
  report: Record<string, unknown>,
  migrations: typeof historySchemaMigrations,
) {
  const names = report.pendingMigrations;
  if (
    !Array.isArray(names) ||
    names.some((name) => !migrations.some((migration) => migration.name === name)) ||
    report.applied !== (names.length === 0)
  )
    throw new HistoryOperatorFailure("report.pendingMigrations");
  const pending = migrations.filter((migration) => names.includes(migration.name));
  if (JSON.stringify(names) !== JSON.stringify(pending.map((migration) => migration.name)))
    throw new HistoryOperatorFailure("report.pendingMigrations");
  return pending;
}

function approvalFor(
  operation: "schema" | "backfill" | "journal-activation",
  report: Record<string, unknown>,
) {
  if (operation === "schema") return hashes(report);
  if (operation === "journal-activation")
    return { ...hashes(report), readersReady: historyJournalReaderVersion };
  if (
    report.version !== historyBackfillVersion ||
    typeof report.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.digest)
  )
    throw new Error("Invalid backfill plan");
  return { digest: report.digest, plan: historyObject(report.plan) };
}

/** The deployed Worker retains its database credential; the operator receives catalog facts only. */
export async function runHistoryOperator(
  options: ReturnType<typeof historyOperatorOptions>,
  accountId: string,
  connect?: (path: string) => Promise<Platform>,
) {
  if (
    options.operation === "journal-activation" &&
    options.apply &&
    options.readersReady !== historyJournalReaderVersion
  )
    throw new Error(
      "Verify deployed reader inventory, then acknowledge --readers-ready checkpoint-count-v1",
    );
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  let approval: ReturnType<typeof approvalFor> | undefined;
  let approvedSchemaState: string | undefined;
  if (options.apply) {
    const saved = historyObject(JSON.parse(await readFile(options.plan, "utf8")));
    if (
      saved.accountId !== accountId ||
      saved.worker !== options.worker ||
      saved.operation !== options.operation
    )
      throw new Error("History schema plan target changed");
    const report = historyObject(saved.report);
    approval = approvalFor(options.operation, report);
    if (options.operation !== "backfill") {
      const preview = schemaPreview(report, options.operation);
      if (
        JSON.stringify(report.pendingDdl) !== JSON.stringify(preview.pendingDdl) ||
        JSON.stringify(report.migrationMarkers) !== JSON.stringify(preview.migrationMarkers)
      )
        throw new Error("History schema statements changed since dry run");
      approvedSchemaState = JSON.stringify({ ...approval, version: report.version, ...preview });
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "pool-history-operator-"));
  const receipt = `${options.plan}.result.json`;
  let platform: Platform | undefined;
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "pool-history-operator",
        account_id: accountId,
        compatibility_date: "2026-09-08",
        services: [
          {
            binding: "POOL_OPERATIONS",
            service: options.worker,
            entrypoint: "PoolOperations",
            remote: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const open: (configPath: string) => Promise<Platform> =
      connect ??
      (async (configPath: string) => {
        const { getPlatformProxy } = createRequire(
          new URL("./startup-profiler/package.json", import.meta.url),
        )("wrangler");
        return getPlatformProxy({ configPath, persist: false, remoteBindings: true });
      });
    platform = await historyOperatorStep("operator.connect", () => open(configPath));
    if (approvedSchemaState) {
      const response = await platform.env.POOL_OPERATIONS.fetch(
        new Request(
          `http://pool-operations${options.operation === "journal-activation" ? historyJournalActivationPath : historySchemaCatalogPath}`,
        ),
      );
      if (!response.ok) throw new Error("History schema catalog refresh failed");
      const current = historyObject(await response.json());
      if (
        current.status !== "dry-run" ||
        current.writes !== false ||
        current.automaticBackfill !== false ||
        JSON.stringify({
          ...approvalFor(options.operation, current),
          version: current.version,
          ...schemaPreview(
            current,
            options.operation === "journal-activation" ? "journal-activation" : "schema",
          ),
        }) !== approvedSchemaState
      )
        throw new Error("History schema plan changed; prepare and approve a fresh dry run");
    }
    if (approval)
      await writeFile(
        receipt,
        JSON.stringify({ status: "started", accountId, worker: options.worker, ...approval }),
        { mode: 0o600, flag: "wx" },
      );
    const path =
      options.operation === "journal-activation"
        ? historyJournalActivationPath
        : options.operation === "backfill"
          ? historyBackfillPath
          : approval
            ? historySchemaApplyPath
            : historySchemaCatalogPath;
    const operations = platform.env.POOL_OPERATIONS;
    const response = await historyOperatorStep("operator.request", () =>
      operations.fetch(
        new Request(
          `http://pool-operations${path}`,
          approval
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...approval, go: true }),
              }
            : {},
        ),
      ),
    );
    if (!response.ok) throw new HistoryOperatorFailure("operator.response.status", response.status);
    let report = await historyOperatorStep("operator.response.json", async () =>
      historyObject(await response.json()),
    );
    if (approval) {
      if (
        report.status !== "complete" ||
        ("schemaHash" in approval
          ? report.schemaHash !== approval.schemaHash ||
            typeof report.applied !== "boolean" ||
            (options.operation === "journal-activation" &&
              report.readersReady !== historyJournalReaderVersion)
          : report.digest !== approval.digest || report.activated !== true)
      )
        throw new Error("Invalid history apply response");
      await writeFile(receipt, JSON.stringify(report), { mode: 0o600 });
    } else {
      approvalFor(options.operation, report);
      if (report.status !== "dry-run") throw new HistoryOperatorFailure("report.status");
      if (report.writes !== false) throw new HistoryOperatorFailure("report.writes");
      if (options.operation !== "backfill" && report.automaticBackfill !== false)
        throw new HistoryOperatorFailure("report.automaticBackfill");
      if (options.operation !== "backfill")
        report = { ...report, ...schemaPreview(report, options.operation) };
      await writeFile(
        options.plan,
        JSON.stringify({ accountId, worker: options.worker, operation: options.operation, report }),
        { mode: 0o600, flag: "wx" },
      );
    }
    return report;
  } finally {
    try {
      await platform?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(
        await runHistoryOperator(
          historyOperatorOptions(process.argv.slice(2)),
          process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
        ),
      ),
    );
  } catch {
    console.error(
      "Pool history operator failed. Inspect the private plan and result before retrying.",
    );
    process.exitCode = 1;
  }
}
