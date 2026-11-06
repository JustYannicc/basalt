import pg from "pg";
import {
  backendCountSql,
  backendVisibilitySql,
  retirement,
  verifyDatabaseBudget,
  type BackendCount,
} from "./database-budget-verification.ts";
import {
  DatabaseBudgetFailure,
  safeDatabaseError,
  type BudgetReceipt,
  type BudgetStage,
} from "./database-budget-receipt.ts";
import { postgresRoleName } from "../src/pool/database-settings.ts";
import { bounded } from "./database-budget-readiness.ts";
import { type RuntimeReady } from "../src/pool/deployment-readiness.ts";

export const databaseVerificationOverallMs = 270_000;
export interface DatabaseClient {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  on(event: "error", listener: () => void): unknown;
  connection: { stream: { destroy(): void } };
}
export async function checkDatabaseBackends(options: {
  adminUrl: string;
  runtimeLogins: string[];
  databases: string[];
  deadlineMs?: number;
  candidate?: string;
  initialReady?: RuntimeReady;
  readyReceivedAt?: number;
  overallDeadline?: number;
  ready?: (signal: AbortSignal) => Promise<RuntimeReady>;
  signal?: AbortSignal;
  now?: () => number;
  wait?: () => Promise<void>;
  client?: DatabaseClient;
  retain?: (receipt: BudgetReceipt) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  const started = now();
  let stage: BudgetStage = "connect";
  const deadlineMs = options.deadlineMs ?? retirement.verificationMs;
  let receipt: BudgetReceipt = {
    candidate: options.candidate ?? "unknown",
    outcome: "converged",
    stage,
    elapsedMs: 0,
    deadlineMs,
    successfulSamples: 0,
    lastSampleAt: null,
    counts: null,
    runtime: options.initialReady ?? null,
    sampleRuntime: null,
  };
  const client =
    options.client ??
    new pg.Client({
      connectionString: options.adminUrl,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
  client.on("error", () => {});
  const abort = new AbortController();
  const externalAbort = () => {
    abort.abort();
    client.connection.stream.destroy();
  };
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  const hardDeadline = setTimeout(
    externalAbort,
    options.ready ? databaseVerificationOverallMs : deadlineMs + 5000,
  );
  let failed: DatabaseBudgetFailure | undefined;
  let counts: BackendCount[] | undefined;
  try {
    options.signal?.throwIfAborted();
    const roles = options.runtimeLogins.map(postgresRoleName);
    if (
      !roles.length ||
      !options.databases.length ||
      new Set(options.databases).size !== options.databases.length
    )
      throw new Error("Explicit runtime roles and databases required");
    await bounded(client.connect(), abort.signal);
    stage = "read";
    counts = await bounded(
      verifyDatabaseBudget({
        databases: options.databases,
        deadlineMs,
        signal: abort.signal,
        candidate: options.candidate,
        initialReady: options.initialReady,
        readyReceivedAt: options.readyReceivedAt ?? started,
        overallDeadline:
          options.overallDeadline ??
          (options.ready ? started + databaseVerificationOverallMs : Infinity),
        ...(options.ready ? { ready: () => options.ready!(abort.signal) } : {}),
        now,
        wait: options.wait,
        observed: (value) => {
          receipt = value;
        },
        read: async () => {
          await client.query("BEGIN TRANSACTION READ ONLY");
          try {
            await client.query("SET LOCAL statement_timeout = '4s'");
            const visibility = await client.query(backendVisibilitySql, [roles]);
            if (
              visibility.rows.length !== 1 ||
              !visibility.rows[0] ||
              typeof visibility.rows[0] !== "object" ||
              !("visible" in visibility.rows[0]) ||
              visibility.rows[0].visible !== true
            )
              throw new DatabaseBudgetFailure({
                ...receipt,
                outcome: "incomplete-visibility",
                stage: "read",
              });
            const result = await client.query(backendCountSql, [roles]);
            await client.query("COMMIT");
            return result.rows.map((row) => {
              if (
                !row ||
                typeof row !== "object" ||
                !("database" in row) ||
                !("connections" in row) ||
                typeof row.database !== "string" ||
                typeof row.connections !== "number"
              )
                throw new DatabaseBudgetFailure({
                  ...receipt,
                  outcome: "invalid-observation",
                  stage: "read",
                });
              return { database: row.database, connections: row.connections };
            });
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
          }
        },
      }),
      abort.signal,
    );
  } catch (error) {
    receipt =
      error instanceof DatabaseBudgetFailure
        ? error.receipt
        : { ...receipt, ...safeDatabaseError(error, abort.signal.aborted ? "converge" : stage) };
    if (abort.signal.aborted) receipt = { ...receipt, outcome: "abort" };
    failed = new DatabaseBudgetFailure(receipt);
  } finally {
    receipt = { ...receipt, elapsedMs: now() - started };
    try {
      await options.retain?.(receipt);
    } finally {
      clearTimeout(hardDeadline);
      options.signal?.removeEventListener("abort", externalAbort);
      client.connection.stream.destroy();
      // Destroy first so end cannot wait for a half-open query or connection handshake.
      let teardownTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.end().catch(() => {}),
          new Promise<void>((resolve) => {
            teardownTimer = setTimeout(resolve, 1000);
          }),
        ]);
      } finally {
        clearTimeout(teardownTimer);
      }
    }
  }
  if (failed) throw new DatabaseBudgetFailure(receipt);
  return counts!;
}

if (import.meta.main) {
  const { runDatabaseBudgetCommand } = await import("./database-budget-command.ts");
  try {
    console.log(JSON.stringify(await runDatabaseBudgetCommand(process.env, process.argv.slice(2))));
  } catch (error) {
    console.error(
      JSON.stringify(
        error instanceof DatabaseBudgetFailure ? error.receipt : { outcome: "receipt-error" },
      ),
    );
    process.exitCode = 1;
  }
}
