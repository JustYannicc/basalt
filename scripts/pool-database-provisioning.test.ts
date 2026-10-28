import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  classify,
  clientConfig,
  limits,
  provisionPoolDatabase,
  type Database,
  type Session,
  worstCaseMs,
} from "./pool-database-provisioning.ts";

const secretUrl = "postgresql://admin:fixture-secret@cluster.example:5432/postgres?sslmode=verify-full";

function postgresError(code: string): Error {
  // Driver messages can name the host or login; none of this may reach the deploy log.
  return Object.assign(new Error(`failure for admin@cluster.example: ${secretUrl}`), { code });
}

type Answer = Error | "hang" | { rowCount: number; rows: Record<string, unknown>[] };

/** A fake cluster where the tools service's pool database is already provisioned. */
function cluster(overrides: { connect?: (database: Database, attempt: number) => Error | undefined; answer?: (sql: string, attempt: number) => Answer | undefined } = {}) {
  const statements: string[] = [];
  const events: string[] = [];
  let attempt = 0;
  const connect = async (database: Database): Promise<Session> => {
    if (database === "cluster") attempt++;
    events.push(`connect ${database}`);
    const failure = overrides.connect?.(database, attempt);
    if (failure) throw failure;
    return {
      async query(sql) {
        statements.push(sql);
        const answer = overrides.answer?.(sql, attempt);
        if (answer === "hang") return new Promise(() => {});
        if (answer instanceof Error) throw answer;
        if (answer) return answer;
        if (sql.includes("FROM pg_roles WHERE rolname") && sql.includes("rolsuper"))
          return { rowCount: 1, rows: [{ rolcanlogin: false, rolsuper: false }] };
        if (sql.includes("FROM pg_database")) return { rowCount: 1, rows: [{ owner: "basalt_pool_owner" }] };
        return { rowCount: 1, rows: [{}] };
      },
      async end() {
        events.push(`end ${database}`);
      },
    };
  };
  return { connect, statements, events };
}

const instant = { sleep: async () => {}, log: () => {} };
const sessionLimits = ["SET lock_timeout = '10s'", "SET statement_timeout = '20s'"];

test("provisioning on an existing cluster runs the same idempotent statements in order", async () => {
  const fake = cluster();
  await provisionPoolDatabase({ runtimeLogin: "pool_runtime.branch", connect: fake.connect, ...instant });
  assert.deepEqual(fake.statements, [
    ...sessionLimits,
    "SELECT pg_advisory_lock(1409, 1)",
    "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
    'GRANT "basalt_pool_owner" TO postgres',
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
    'REVOKE ALL ON DATABASE "basalt_pool" FROM PUBLIC',
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    'GRANT "basalt_pool_owner" TO "pool_runtime"',
    ...sessionLimits,
    "REVOKE ALL ON SCHEMA public FROM PUBLIC",
    'GRANT ALL ON SCHEMA public TO "basalt_pool_owner"',
  ]);
  assert.deepEqual(fake.events, ["connect cluster", "connect pool", "end cluster", "end pool"]);
});

test("every attempt's sessions set their lock and statement limits before anything else", async () => {
  const perSession: string[][] = [];
  const fake = cluster({ answer: (sql, attempt) => (sql.includes("advisory") && attempt < 3 ? postgresError("55P03") : undefined) });
  await provisionPoolDatabase({
    runtimeLogin: "pool_runtime",
    connect: async (database) => {
      const session = await fake.connect(database);
      const statements: string[] = [];
      perSession.push(statements);
      return { query: (sql, values) => (statements.push(sql), session.query(sql, values)), end: () => session.end() };
    },
    ...instant,
  });
  assert.equal(perSession.length, 4, "three cluster sessions and one pool session");
  for (const statements of perSession) assert.deepEqual(statements.slice(0, 2), sessionLimits);
});

test("a fresh cluster gets the owner role and the pool database", async () => {
  const fake = cluster({
    answer: (sql) => (sql.includes("rolsuper") || sql.includes("FROM pg_database") ? { rowCount: 0, rows: [] } : undefined),
  });
  await provisionPoolDatabase({ runtimeLogin: "pool_runtime", connect: fake.connect, ...instant });
  assert.ok(fake.statements.includes('CREATE ROLE "basalt_pool_owner" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'));
  assert.ok(fake.statements.includes('CREATE DATABASE "basalt_pool" OWNER "basalt_pool_owner"'));
});

test("a lock timeout closes the attempt's sessions and retries on fresh ones", async () => {
  const logs: string[] = [];
  const sleeps: number[] = [];
  const fake = cluster({ answer: (sql, attempt) => (sql.includes("advisory") && attempt === 1 ? postgresError("55P03") : undefined) });
  await provisionPoolDatabase({
    runtimeLogin: "pool_runtime",
    connect: fake.connect,
    sleep: async (ms) => void sleeps.push(ms),
    log: (line) => void logs.push(line),
  });
  assert.deepEqual(fake.events.slice(0, 3), ["connect cluster", "end cluster", "connect cluster"]);
  assert.deepEqual(sleeps, [2_000]);
  assert.deepEqual(logs, [
    'Pool database provisioning failed at "take the provisioning lock" (attempt 1 of 3): lock timeout (55P03); retrying in 2s',
  ]);
});

test("a cluster that never accepts connections fails after three bounded attempts, naming the step", async () => {
  const sleeps: number[] = [];
  const fake = cluster({ connect: () => new Error("timeout expired") });
  await assert.rejects(
    provisionPoolDatabase({ runtimeLogin: "pool_runtime", connect: fake.connect, sleep: async (ms) => void sleeps.push(ms), log: () => {} }),
    { message: 'Pool database provisioning failed at "connect to the cluster" after 3 attempts: connect timeout' },
  );
  assert.deepEqual(sleeps, [2_000, 4_000]);
});

test("a hung statement is abandoned at the attempt deadline and its session closed", async () => {
  const logs: string[] = [];
  const fake = cluster({ answer: (sql, attempt) => (sql.includes("REVOKE ALL ON SCHEMA") && attempt === 1 ? "hang" : undefined) });
  await provisionPoolDatabase({ runtimeLogin: "pool_runtime", connect: fake.connect, attemptMs: 20, sleep: async () => {}, log: (line) => void logs.push(line) });
  assert.match(logs[0]!, /at "revoke public access to the public schema" \(attempt 1 of 3\): attempt deadline exceeded/);
  assert.deepEqual(fake.events.slice(0, 5), ["connect cluster", "connect pool", "end cluster", "end pool", "connect cluster"]);
});

test("permanent failures stop at once and never print driver messages or connection details", async () => {
  const fake = cluster({ answer: (sql) => (sql === 'GRANT "basalt_pool_owner" TO postgres' ? postgresError("42501") : undefined) });
  const error = await provisionPoolDatabase({ runtimeLogin: "pool_runtime", connect: fake.connect, ...instant }).then(
    () => assert.fail("expected a failure"),
    (error: Error) => error,
  );
  assert.equal(error.message, 'Pool database provisioning failed at "grant the owner role to postgres": Postgres error 42501');
  assert.doesNotMatch(error.message, /cluster\.example|fixture-secret|admin@/);
  assert.deepEqual(fake.events.filter((event) => event.startsWith("connect")), ["connect cluster"]);
});

test("the script's own checks keep their message and are not retried", async () => {
  const fake = cluster({ answer: (sql) => (sql.includes("rolsuper") ? { rowCount: 1, rows: [{ rolsuper: true }] } : undefined) });
  await assert.rejects(provisionPoolDatabase({ runtimeLogin: "pool_runtime", connect: fake.connect, ...instant }), {
    message: 'Pool database provisioning failed at "check the owner role": The pool database owner has unexpected privileges',
  });
  assert.equal(fake.events.filter((event) => event === "connect cluster").length, 1);
});

test("only connection, lock and timeout failures are retryable", () => {
  for (const code of ["55P03", "57014", "40P01", "08006", "57P03"]) assert.equal(classify(postgresError(code)).retryable, true, code);
  for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"])
    assert.deepEqual(classify(Object.assign(new Error("x"), { code })), { reason: `network error (${code})`, retryable: true });
  assert.deepEqual(classify(new Error("Query read timeout")), { reason: "client read timeout", retryable: true });
  for (const error of [postgresError("42501"), postgresError("28P01"), Object.assign(new Error("x"), { code: "ENOTFOUND" }), new Error(secretUrl)])
    assert.equal(classify(error).retryable, false);
  assert.deepEqual(classify(new Error(secretUrl)), { reason: "unexpected error", retryable: false });
});

test("startup options stay byte-identical to the routing PlanetScale already accepts; client waits are bounded", () => {
  // The pre-timeout script built these URLs exactly like this.
  const before = new URL(secretUrl);
  before.searchParams.set("options", "-c role=postgres");
  const beforePool = new URL(before);
  beforePool.pathname = "/basalt_pool";
  assert.equal(clientConfig(secretUrl, "cluster").connectionString, before.toString());
  assert.equal(clientConfig(secretUrl, "pool").connectionString, beforePool.toString());
  for (const database of ["cluster", "pool"] as const) {
    const config = clientConfig(secretUrl, database);
    const url = new URL(config.connectionString);
    assert.equal(url.pathname, database === "pool" ? "/basalt_pool" : "/postgres");
    assert.equal(url.username, "admin");
    assert.equal(url.searchParams.get("sslmode"), "verify-full");
    assert.equal(url.searchParams.get("options"), "-c role=postgres");
    assert.equal(config.connectionTimeoutMillis, 10_000);
    assert.equal(config.query_timeout, 25_000);
    assert.equal(config.keepAlive, true);
  }
  assert.ok(limits.lockMs < limits.statementMs && limits.statementMs < limits.queryMs && limits.queryMs < limits.attemptMs);
  assert.ok(limits.connectMs + limits.queryMs <= limits.attemptMs, "one hung connect or statement surfaces before the deadline");
});

test("the deploy's command timeout exceeds the script's worst case", () => {
  assert.equal(worstCaseMs, 132_000);
  const source = readFileSync(new URL("../src/pool/database.ts", import.meta.url), "utf8");
  const minutes = Number(source.match(/timeout: "(\d+) minutes?"/)?.[1]);
  assert.ok(minutes * 60_000 >= worstCaseMs + 30_000, `${minutes} minutes leaves no headroom over ${worstCaseMs}ms`);
});
