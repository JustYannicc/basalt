import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkpointReaderContract } from "./migration-activation-contract.ts";
import type { HistoryOperator } from "./migration-activation-source.ts";
import { digest, BarrierRefusal } from "./manifest.ts";

const cloud = fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export async function historyPlan(operator: HistoryOperator, accountId: string, worker: string) {
  const directory = await mkdtemp(join(tmpdir(), "migration-activation-plan-"));
  try {
    const report = await operator(
      { worker, plan: join(directory, "plan.json"), operation: "journal-activation", apply: false },
      accountId,
    );
    if (
      !record(report) ||
      !record(report.catalog) ||
      report.status !== "dry-run" ||
      report.writes !== false ||
      report.automaticBackfill !== false ||
      report.version !== "model_request_history_v10_change_journal_activate" ||
      report.readersReadyRequired !== checkpointReaderContract ||
      !hash(report.schemaHash) ||
      !hash(report.catalogHash) ||
      digest(JSON.stringify(report.catalog)) !== report.catalogHash ||
      typeof report.applied !== "boolean" ||
      report.catalog.journalActivated !== report.applied ||
      typeof report.catalog.journalPrepared !== "boolean"
    )
      throw new Error();
    // Only these two observations vary under ordinary traffic; all apply preview fields stay bound.
    const { history: _history, ledgerRows: _ledgerRows, ...material } = report;
    return {
      report: material,
      prepared: report.catalog.journalPrepared,
      active: report.applied,
      schemaHash: report.schemaHash,
      catalogHash: report.catalogHash,
    };
  } catch {
    throw new BarrierRefusal("migration-activation-pool-plan", "PoolWorker");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** This child receives the existing role only through env; raw output is discarded at the boundary. */
export function activateHosted(databaseUrl: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["src/migrate.ts", "--activate-change-journal", "--readers-ready=checkpoint-count-v1"],
      {
        cwd: cloud,
        env: { DATABASE_URL: databaseUrl },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 7 * 60_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new BarrierRefusal("migration-activation-hosted-command", "hosted"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new BarrierRefusal("migration-activation-hosted-command", "hosted"));
    });
  });
}
