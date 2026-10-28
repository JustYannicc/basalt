import { poolDatabase, postgresRoleName } from "../src/pool/database-settings.ts";

/**
 * Every wait in provisioning is bounded, so a stuck connect or lock becomes a specific failure
 * instead of the deploy's command timeout. Server-side limits travel in the startup `options`,
 * the same path that already carries `role=postgres`.
 */
export const limits = {
  connectMs: 10_000,
  lockMs: 10_000,
  statementMs: 20_000,
  // Client-side read limit, after the server's own, for a server that stops answering.
  queryMs: 25_000,
  attemptMs: 40_000,
  closeMs: 2_000,
  // One wait before each retry, so three attempts.
  backoffMs: [2_000, 4_000],
} as const;
const attempts = limits.backoffMs.length + 1;

/** 3 × (40s attempt + 2s close) + 2s + 4s backoff = 132s. src/pool/database.ts allows 3 minutes. */
export const worstCaseMs =
  attempts * (limits.attemptMs + limits.closeMs) + limits.backoffMs.reduce((sum, ms) => sum + ms, 0);

export type Database = "cluster" | "pool";

export interface Session {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/** pg client settings for the admin login on the cluster's `postgres` database or the pool database. */
export function clientConfig(adminUrl: string, database: Database) {
  const url = new URL(adminUrl);
  if (database === "pool") url.pathname = `/${poolDatabase.name}`;
  url.searchParams.set(
    "options",
    `-c role=postgres -c lock_timeout=${limits.lockMs}ms -c statement_timeout=${limits.statementMs}ms`,
  );
  return {
    connectionString: url.toString(),
    connectionTimeoutMillis: limits.connectMs,
    query_timeout: limits.queryMs,
    keepAlive: true,
  };
}

/** Raised for checks this script makes itself; its message never contains connection details. */
export class ProvisioningError extends Error {}

class AttemptExpired extends Error {}

const retryableStates: Record<string, string> = {
  "55P03": "lock timeout",
  "57014": "statement timeout",
  "40P01": "deadlock",
  "53300": "too many connections",
  "57P01": "server shutting down",
  "57P02": "server crashed",
  "57P03": "server not accepting connections",
};
const networkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);
// node-postgres's own messages carry no connection details.
const clientMessages: Record<string, string> = {
  "timeout expired": "connect timeout",
  "Query read timeout": "client read timeout",
  "Connection terminated": "connection closed",
  "Connection terminated unexpectedly": "connection closed",
};

/** A log-safe reason, and whether a fresh attempt could succeed. Driver messages can contain hosts or logins. */
export function classify(error: unknown): { reason: string; retryable: boolean } {
  if (error instanceof ProvisioningError) return { reason: error.message, retryable: false };
  if (error instanceof AttemptExpired) return { reason: "attempt deadline exceeded", retryable: true };
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (/^[A-Z0-9]{5}$/.test(code)) {
    const label = retryableStates[code] ?? (code.startsWith("08") ? "connection failure" : undefined);
    return label ? { reason: `${label} (${code})`, retryable: true } : { reason: `Postgres error ${code}`, retryable: false };
  }
  if (networkCodes.has(code)) return { reason: `network error (${code})`, retryable: true };
  const message = error instanceof Error ? clientMessages[error.message] : undefined;
  if (message) return { reason: message, retryable: true };
  return { reason: "unexpected error", retryable: false };
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** One idempotent pass: every write is guarded by a check or is a repeatable GRANT/REVOKE. */
async function provisionOnce(
  open: (database: Database) => Promise<Session>,
  step: (label: string) => void,
  runtimeRole: string,
): Promise<void> {
  const owner = identifier(poolDatabase.owner);
  const database = identifier(poolDatabase.name);
  step("connect to the cluster");
  const admin = await open("cluster");
  step("take the provisioning lock");
  await admin.query("SELECT pg_advisory_lock(1409, 1)");
  step("check the owner role");
  const existingOwner = await admin.query(
    "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [poolDatabase.owner],
  );
  if (!existingOwner.rowCount) {
    step("create the owner role");
    await admin.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  } else if (Object.values(existingOwner.rows[0] ?? {}).some(Boolean)) {
    throw new ProvisioningError("The pool database owner has unexpected privileges");
  }
  // CREATEDB alone cannot assign another owner. PlanetScale's postgres is not a superuser.
  step("grant the owner role to postgres");
  await admin.query(`GRANT ${owner} TO postgres`);
  step("check the pool database");
  const existingDatabase = await admin.query(
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
    [poolDatabase.name],
  );
  if (!existingDatabase.rowCount) {
    step("create the pool database");
    await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
  } else if (existingDatabase.rows[0]?.owner !== poolDatabase.owner) {
    throw new ProvisioningError("The pool database has an unexpected owner");
  }
  step("revoke public access to the pool database");
  await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  step("check the runtime role");
  const runtime = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [runtimeRole]);
  if (!runtime.rowCount) throw new ProvisioningError("The pool runtime role does not exist on the cluster");
  step("grant the owner role to the runtime role");
  await admin.query(`GRANT ${owner} TO ${identifier(runtimeRole)}`);
  step("connect to the pool database");
  const scoped = await open("pool");
  step("revoke public access to the public schema");
  await scoped.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  step("grant the public schema to the owner");
  await scoped.query(`GRANT ALL ON SCHEMA public TO ${owner}`);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for `promise` at most `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ProvisionOptions {
  runtimeLogin: string;
  connect: (database: Database) => Promise<Session>;
  attemptMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Runs provisioning with bounded attempts. Each attempt opens fresh sessions, so its advisory lock
 * is released when the attempt's sessions close. Only connect, lock and timeout failures retry.
 */
export async function provisionPoolDatabase(options: ProvisionOptions): Promise<void> {
  const runtimeRole = postgresRoleName(options.runtimeLogin);
  const attemptMs = options.attemptMs ?? limits.attemptMs;
  const sleep = options.sleep ?? wait;
  const log = options.log ?? ((line: string) => console.error(line));
  for (let attempt = 1; ; attempt++) {
    if (attempt > 1) await sleep(limits.backoffMs[attempt - 2]!);
    let current = "start";
    let expired = false;
    const sessions: Session[] = [];
    const open = async (database: Database) => {
      const session = await options.connect(database);
      if (expired) {
        void within(session.end().catch(() => {}), limits.closeMs);
        throw new AttemptExpired();
      }
      sessions.push(session);
      return session;
    };
    const step = (label: string) => {
      if (expired) throw new AttemptExpired();
      current = label;
    };
    const run = provisionOnce(open, step, runtimeRole);
    run.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new AttemptExpired());
      }, attemptMs);
    });
    try {
      await Promise.race([run, deadline]);
      return;
    } catch (error) {
      const { reason, retryable } = classify(error);
      const where = `Pool database provisioning failed at "${current}"`;
      if (!retryable) throw new Error(`${where}: ${reason}`);
      if (attempt >= attempts) throw new Error(`${where} after ${attempt} attempts: ${reason}`);
      log(`${where} (attempt ${attempt} of ${attempts}): ${reason}; retrying in ${limits.backoffMs[attempt - 1]! / 1000}s`);
    } finally {
      clearTimeout(timer);
      // Ending a session releases its advisory lock; a session that cannot end in time is abandoned.
      await closeAll(sessions);
    }
  }
}

async function closeAll(sessions: Session[]): Promise<void> {
  await Promise.all(sessions.splice(0).map((session) => within(session.end().catch(() => {}), limits.closeMs)));
}
