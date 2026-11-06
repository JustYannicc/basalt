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

export const databaseVerificationCommandMs = 115_000;

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

export async function runDatabaseBudgetCommand(
  source: NodeJS.ProcessEnv,
  args: string[],
  adapters: {
    open?: typeof openDeploymentReadiness;
    check?: typeof checkDatabaseBackends;
    now?: () => number;
    timeout?: (milliseconds: number) => AbortSignal;
  } = {},
) {
  const now = adapters.now ?? Date.now;
  const timeout = adapters.timeout ?? AbortSignal.timeout;
  const open = adapters.open ?? openDeploymentReadiness;
  const check = adapters.check ?? checkDatabaseBackends;
  let readiness: Awaited<ReturnType<typeof openDeploymentReadiness>> | undefined;
  const startedAt = now();
  let operationStartedAt = startedAt;
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
  const contextual = (value: BudgetReceipt): BudgetReceipt => ({
    ...value,
    target,
    operationStartedAt,
    overallDeadlineMs: databaseVerificationOverallMs,
    commandDeadlineMs: args.includes("--ready") ? 180_000 : databaseVerificationCommandMs,
    elapsedMs: now() - operationStartedAt,
  });
  const mode = args.includes("--ready") ? "ready" : "verify";
  try {
    const worker = source.DATABASE_BUDGET_WORKER;
    const previous =
      worker && mode === "verify"
        ? JSON.parse(await readFile(source.DATABASE_BUDGET_READY_RECEIPT ?? "", "utf8"))
        : undefined;
    const initialReady = previous ? decodeRuntimeReady(previous.ready, target) : undefined;
    if (
      previous &&
      (!Number.isSafeInteger(previous.startedAt) ||
        !Number.isSafeInteger(previous.readyReceivedAt) ||
        previous.startedAt > previous.readyReceivedAt ||
        previous.readyReceivedAt > now())
    )
      throw new Error("Invalid readiness timing receipt");
    operationStartedAt = previous?.startedAt ?? startedAt;
    receipt = contextual({ ...receipt, runtime: initialReady ?? null });
    const overallDeadline = operationStartedAt + databaseVerificationOverallMs;
    const remaining = overallDeadline - now();
    if (!Number.isFinite(remaining) || remaining <= 0)
      throw new Error("Overall verification bound expired");
    const operation = timeout(
      mode === "ready" ? 180_000 : Math.min(remaining, databaseVerificationCommandMs),
    );
    const startup = mode === "ready" ? operation : AbortSignal.any([operation, timeout(180_000)]);
    if (worker) {
      const opening = open({
        worker,
        accountId: source.CLOUDFLARE_ACCOUNT_ID ?? "",
        key: source.POOL_DEPLOYMENT_KEY ?? "",
        target,
      });
      opening.then(
        (connection) => {
          if (startup.aborted) void bounded(connection.close(), timeout(1000)).catch(() => {});
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
        elapsedMs: now() - startedAt,
      };
      await save(path, { startedAt, readyReceivedAt: now(), ready });
    } else {
      await check({
        adminUrl: source.DATABASE_BUDGET_ADMIN_URL ?? "",
        runtimeLogins: list(source.DATABASE_BUDGET_RUNTIME_LOGINS),
        databases: list(source.DATABASE_BUDGET_DATABASES),
        candidate,
        initialReady,
        readyReceivedAt: previous?.readyReceivedAt,
        overallDeadline,
        ...(readiness
          ? {
              ready: (signal: AbortSignal) =>
                readiness!.ready(AbortSignal.any([signal, timeout(180_000)])),
            }
          : {}),
        signal: operation,
        now,
        retain: async (value) => {
          receipt = contextual(value);
          await save(path, receipt);
        },
      });
    }
    return contextual(receipt);
  } catch (error) {
    if (error instanceof DatabaseBudgetFailure) receipt = error.receipt;
    else
      receipt = {
        ...receipt,
        ...safeDatabaseError(error, "readiness"),
        elapsedMs: now() - startedAt,
      };
    receipt = contextual(receipt);
    await save(path, receipt);
    throw new DatabaseBudgetFailure(receipt);
  } finally {
    if (readiness) await bounded(readiness.close(), timeout(1000)).catch(() => {});
  }
}
