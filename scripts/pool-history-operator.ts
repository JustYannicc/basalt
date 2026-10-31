import { parseArgs } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyObject } from "../src/pool/model-history/record.ts";
import { historyBackfillPath, historyBackfillVersion, historySchemaApplyPath, historySchemaCatalogPath } from "../src/pool/model-history/operator.ts";

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
  if (value.version !== "model_request_history_v1" || typeof value.schemaHash !== "string" || !/^[a-f0-9]{64}$/.test(value.schemaHash)
    || typeof value.catalogHash !== "string" || !/^[a-f0-9]{64}$/.test(value.catalogHash)) throw new Error("Invalid history schema plan");
  return { schemaHash: value.schemaHash, catalogHash: value.catalogHash };
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
  if (options.apply) {
    const saved = historyObject(JSON.parse(await readFile(options.plan, "utf8")));
    if (saved.accountId !== accountId || saved.worker !== options.worker || saved.operation !== options.operation) throw new Error("History schema plan target changed");
    approval = approvalFor(options.operation, historyObject(saved.report));
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
    if (approval) await writeFile(receipt, JSON.stringify({ status: "started", accountId, worker: options.worker, ...approval }),
      { mode: 0o600, flag: "wx" });
    const path = options.operation === "backfill" ? historyBackfillPath : approval ? historySchemaApplyPath : historySchemaCatalogPath;
    const response = await platform.env.POOL_OPERATIONS.fetch(new Request(`http://pool-operations${path}`, {
      ...(approval ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...approval, go: true }) } : {}),
    }));
    if (!response.ok) throw new Error("History operator failed; inspect the private receipt before another apply");
    const report = historyObject(await response.json());
    if (approval) {
      if (report.status !== "complete" || ("schemaHash" in approval
        ? report.schemaHash !== approval.schemaHash || typeof report.applied !== "boolean"
        : report.digest !== approval.digest || report.activated !== true)) throw new Error("Invalid history apply response");
      await writeFile(receipt, JSON.stringify(report), { mode: 0o600 });
    } else {
      approvalFor(options.operation, report);
      if (report.status !== "dry-run" || report.writes !== false || options.operation === "schema" && report.automaticBackfill !== false) throw new Error("Invalid history schema dry run");
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
