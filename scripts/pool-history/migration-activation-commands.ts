import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointReaderContract } from "./migration-activation-contract.ts";
import type { HistoryOperator } from "./migration-activation-source.ts";
import { digest, BarrierRefusal } from "../pool-fleet/manifest.ts";
import { HistoryOperatorFailure } from "../pool-history-operator-failure.ts";
import { safeProviderFailureChain } from "./operation-failure.ts";

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
    if (!record(report)) throw new HistoryOperatorFailure("operator.response.json");
    if (!record(report.catalog)) throw new HistoryOperatorFailure("report.catalog");
    if (report.status !== "dry-run") throw new HistoryOperatorFailure("report.status");
    if (report.writes !== false) throw new HistoryOperatorFailure("report.writes");
    if (report.automaticBackfill !== false)
      throw new HistoryOperatorFailure("report.automaticBackfill");
    if (report.version !== "model_request_history_v10_change_journal_activate")
      throw new HistoryOperatorFailure("report.version");
    if (report.readersReadyRequired !== checkpointReaderContract)
      throw new HistoryOperatorFailure("report.readersReadyRequired");
    if (!hash(report.schemaHash)) throw new HistoryOperatorFailure("report.schemaHash");
    if (!hash(report.catalogHash) || digest(JSON.stringify(report.catalog)) !== report.catalogHash)
      throw new HistoryOperatorFailure("report.catalogHash");
    if (typeof report.applied !== "boolean") throw new HistoryOperatorFailure("report.applied");
    if (report.catalog.journalActivated !== report.applied)
      throw new HistoryOperatorFailure("report.catalog.journalActivated");
    if (typeof report.catalog.journalPrepared !== "boolean")
      throw new HistoryOperatorFailure("report.catalog.journalPrepared");
    // Only these two observations vary under ordinary traffic; all apply preview fields stay bound.
    const { history: _history, ledgerRows: _ledgerRows, ...material } = report;
    return {
      report: material,
      prepared: report.catalog.journalPrepared,
      active: report.applied,
      schemaHash: report.schemaHash,
      catalogHash: report.catalogHash,
    };
  } catch (error) {
    const failure =
      error instanceof HistoryOperatorFailure
        ? error
        : new HistoryOperatorFailure("operator.invoke", undefined, error);
    const providers = safeProviderFailureChain(failure.cause);
    throw new BarrierRefusal("migration-activation-pool-plan", "PoolWorker", {
      fqn: "PoolWorker",
      type: "PoolHistoryOperator",
      changed: [
        failure.field === "operator.response.status" && failure.status !== undefined
          ? { path: failure.field, old: 200, new: failure.status }
          : { path: failure.field, changed: true },
      ],
      ...(providers.length
        ? {
            why: [
              ...(failure.field === "operator.load-wrangler" ? ["phase=wrangler-load"] : []),
              ...(failure.field === "operator.connect" ? ["phase=proxy-open"] : []),
              `runtime=${process.versions.bun ? "bun" : "node"}`,
              ...providers.flatMap((provider, index) => {
                const prefix = index === 0 ? "" : `cause.${index}.`;
                return [
                  `${prefix}type=${provider.type}`,
                  ...(provider.reason ? [`${prefix}reason=${provider.reason}`] : []),
                  ...(provider.status === undefined ? [] : [`${prefix}status=${provider.status}`]),
                  ...(provider.codes?.length ? [`${prefix}codes=${provider.codes.join(",")}`] : []),
                  ...(provider.code ? [`${prefix}code=${provider.code}`] : []),
                ];
              }),
            ],
          }
        : {}),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * This child receives the existing role only through env; raw output is discarded at the boundary.
 * `cloud` is the candidate's prepared hosted app, so the migration that runs is the released one.
 */
export function activateHosted(databaseUrl: string, cloud: string) {
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
