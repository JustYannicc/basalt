import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkDatabaseBackends, databaseVerificationOverallMs } from "./verify-database-budget.ts";
import { bounded, openDeploymentReadiness } from "./database-budget-readiness.ts";
import { decodeRuntimeReady } from "../src/pool/deployment-readiness.ts";
import {
  DatabaseBudgetFailure,
  safeDatabaseError,
  type BudgetReceipt,
} from "./database-budget-receipt.ts";

function list(value: string | undefined) {
  const parsed: unknown = JSON.parse(value ?? "null");
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some((entry) => typeof entry !== "string" || !entry)
  )
    throw new Error("Database budget verification requires explicit runtime logins and databases");
  return parsed as string[];
}
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
}

export async function runDatabaseBudgetCommand(source: NodeJS.ProcessEnv, args: string[]) {
  let readiness: Awaited<ReturnType<typeof openDeploymentReadiness>> | undefined;
  const startedAt = Date.now();
  const path = source.DATABASE_BUDGET_RECEIPT ?? "";
  const candidate = source.GITHUB_SHA ?? "unknown";
  const target = {
    candidate,
    workerInput: source.DATABASE_BUDGET_WORKER_INPUT ?? "",
    imageHash: source.DATABASE_BUDGET_IMAGE_HASH ?? "",
  };
  let receipt: BudgetReceipt = {
    candidate,
    outcome: "readiness-error",
    stage: "readiness",
    elapsedMs: 0,
    deadlineMs: 180_000,
    successfulSamples: 0,
    lastSampleAt: null,
    counts: null,
    runtime: null,
    sampleRuntime: null,
  };
  const mode = args.includes("--ready") ? "ready" : "verify";
  try {
    const worker = source.DATABASE_BUDGET_WORKER;
    const startup = AbortSignal.timeout(180_000);
    if (worker) {
      const opening = openDeploymentReadiness({
        worker,
        accountId: source.CLOUDFLARE_ACCOUNT_ID ?? "",
        key: source.POOL_DEPLOYMENT_KEY ?? "",
        target,
      });
      opening.then(
        (connection) => {
          if (startup.aborted) void connection.close();
        },
        () => {},
      );
      readiness = await bounded(opening, startup);
    }
    if (mode === "ready") {
      if (!readiness) throw new Error("Readiness service missing");
      const ready = await readiness.ready(startup);
      receipt = {
        ...receipt,
        outcome: "converged",
        runtime: ready,
        elapsedMs: Date.now() - startedAt,
      };
      await save(path, { startedAt, readyReceivedAt: Date.now(), ready });
    } else {
      const previous = readiness
        ? JSON.parse(await readFile(source.DATABASE_BUDGET_READY_RECEIPT ?? "", "utf8"))
        : undefined;
      const initialReady = previous ? decodeRuntimeReady(previous.ready, target) : undefined;
      const remaining = previous
        ? databaseVerificationOverallMs - (Date.now() - previous.startedAt)
        : databaseVerificationOverallMs;
      if (
        (previous &&
          (!Number.isSafeInteger(previous.startedAt) ||
            !Number.isSafeInteger(previous.readyReceivedAt))) ||
        !Number.isFinite(remaining) ||
        remaining <= 0
      )
        throw new Error("Overall verification bound expired");
      await checkDatabaseBackends({
        adminUrl: source.DATABASE_BUDGET_ADMIN_URL ?? "",
        runtimeLogins: list(source.DATABASE_BUDGET_RUNTIME_LOGINS),
        databases: list(source.DATABASE_BUDGET_DATABASES),
        candidate,
        initialReady,
        readyReceivedAt: previous?.readyReceivedAt,
        overallDeadline: previous ? previous.startedAt + databaseVerificationOverallMs : undefined,
        ...(readiness ? { ready: readiness.ready } : {}),
        signal: AbortSignal.timeout(remaining),
        retain: async (value) => {
          receipt = value;
          await save(path, value);
        },
      });
    }
    return receipt;
  } catch (error) {
    if (error instanceof DatabaseBudgetFailure) receipt = error.receipt;
    else
      receipt = {
        ...receipt,
        ...safeDatabaseError(error, "readiness"),
        elapsedMs: Date.now() - startedAt,
      };
    await save(path, receipt);
    throw new DatabaseBudgetFailure(receipt);
  } finally {
    if (readiness) await bounded(readiness.close(), AbortSignal.timeout(1000)).catch(() => {});
  }
}
