import { setTimeout as delay } from "node:timers/promises";
import {
  databaseBackendBudget,
  retirement,
} from "../.upstream/apps/hosted/cloud/src/infrastructure/database-pool-policy.ts";
import {
  backendCountSql,
  backendVisibilitySql,
} from "../.upstream/apps/hosted/cloud/src/infrastructure/database-budget-observation.ts";
import {
  DatabaseBudgetFailure,
  type BackendCount,
  type BudgetReceipt,
  type BudgetStage,
  safeDatabaseError,
} from "./database-budget-receipt.ts";
import type { RuntimeReady } from "../src/pool/deployment-readiness.ts";
export {
  backendCountSql,
  backendVisibilitySql,
  databaseBackendBudget,
  retirement,
  type BackendCount,
};

export async function verifyDatabaseBudget(options: {
  databases: readonly string[];
  read: () => Promise<BackendCount[]>;
  ready?: () => Promise<RuntimeReady>;
  initialReady?: RuntimeReady;
  readyReceivedAt?: number;
  overallDeadline?: number;
  candidate?: string;
  deadlineMs?: number;
  now?: () => number;
  wait?: () => Promise<void>;
  signal?: AbortSignal;
  observed?: (receipt: BudgetReceipt) => void;
}) {
  const now = options.now ?? Date.now;
  const started = now();
  const deadlineMs = options.deadlineMs ?? retirement.verificationMs;
  let deadline = (options.readyReceivedAt ?? started) + deadlineMs;
  let stage: BudgetStage = "readiness";
  let runtime = options.initialReady ?? null;
  const receipt: BudgetReceipt = {
    candidate: options.candidate ?? "unknown",
    outcome: "converged",
    stage,
    elapsedMs: 0,
    deadlineMs,
    successfulSamples: 0,
    lastSampleAt: null,
    counts: null,
    runtime,
    sampleRuntime: null,
  };
  const publish = () => {
    Object.assign(receipt, { stage, elapsedMs: now() - started, runtime });
    options.observed?.({ ...receipt });
  };
  const checkOverall = () => {
    options.signal?.throwIfAborted();
    if (now() >= (options.overallDeadline ?? Infinity))
      throw new DOMException("Operation aborted", "AbortError");
  };
  const adopt = async () => {
    checkOverall();
    if (!options.ready) return false;
    stage = "readiness";
    const next = await options.ready();
    checkOverall();
    const changed =
      !runtime || runtime.bootId !== next.bootId || runtime.instanceId !== next.instanceId;
    runtime = next;
    if (changed) deadline = now() + deadlineMs;
    return changed;
  };
  const wait = options.wait ?? (() => delay(1000, undefined, { signal: options.signal }));
  try {
    await adopt();
    do {
      options.signal?.throwIfAborted();
      await adopt();
      stage = "read";
      const rows = await options.read();
      const seen = new Set<string>();
      if (
        rows.some(
          (row) =>
            !options.databases.includes(row.database) ||
            seen.has(row.database) ||
            !seen.add(row.database) ||
            !Number.isSafeInteger(row.connections) ||
            row.connections < 0,
        )
      ) {
        receipt.outcome = "invalid-observation";
        throw new DatabaseBudgetFailure(receipt);
      }
      const counts = options.databases.map((database) => ({
        database,
        connections: rows.find((row) => row.database === database)?.connections ?? 0,
      }));
      if (await adopt()) continue;
      receipt.counts = counts;
      receipt.sampleRuntime = runtime;
      receipt.successfulSamples++;
      receipt.lastSampleAt = now();
      stage = "converge";
      publish();
      if (now() <= deadline && counts.every((row) => row.connections <= databaseBackendBudget))
        return counts;
      if (now() >= deadline) break;
      await wait();
    } while (now() <= deadline);
    receipt.outcome = "over-budget-deadline";
    throw new DatabaseBudgetFailure(receipt);
  } catch (error) {
    if (error instanceof DatabaseBudgetFailure) receipt.outcome = error.receipt.outcome;
    else Object.assign(receipt, safeDatabaseError(error, stage));
    publish();
    throw new DatabaseBudgetFailure(receipt);
  }
}
