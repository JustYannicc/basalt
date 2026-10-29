import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Duration, Effect } from "effect";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const guard = await load("apps/hosted/cloud/src/implementation/migration-guard.ts");
const hosted = await load("apps/hosted/server/src/implementation/migrations.ts");
const {
  formatBlockerRows,
  guardMigration,
  migrationLimits,
  migrationSessionSettings,
  migrationHardLimit,
  migrationWorstCase,
  queryFingerprint,
} = guard;
const { HostedMigrationFailed, migrationPhase } = hosted;

const fast = {
  attempt: Duration.millis(200),
  report: Duration.millis(100),
  retryAfter: Duration.millis(1),
  close: Duration.millis(100),
};
const lockTimeout = () =>
  new HostedMigrationFailed({ stage: "product", causeTags: ["SqlError"], sqlState: "55P03" });

/** Runs the guard over scripted attempts; returns the outcome, stderr lines and attempt count. */
async function run(attempts: ReadonlyArray<Effect.Effect<void, unknown>>, report?: Effect.Effect<ReadonlyArray<string>>) {
  const lines: Array<string> = [];
  const original = console.error;
  console.error = (...args: Array<unknown>) => void lines.push(args.join(" "));
  let calls = 0;
  try {
    const exit = await Effect.runPromiseExit(
      guardMigration({
        attempt: Effect.suspend(() => attempts[Math.min(calls++, attempts.length - 1)]!),
        report: report ?? Effect.succeed(["Blocker report: fixture"]),
        limits: fast,
      }),
    );
    const steps = lines.filter((line) => line.startsWith("Migration step "));
    return { exit, lines: lines.filter((line) => !steps.includes(line)), steps, calls };
  } finally {
    console.error = original;
  }
}

const failure = (exit: any) => {
  assert.equal(exit._tag, "Failure");
  const error = exit.cause.reasons.find((reason: any) => reason._tag === "Fail")?.error;
  assert.ok(error, "expected a typed failure");
  return error;
};

test("a run that finishes writes only its steps and runs once", async () => {
  const { exit, lines, steps, calls } = await run([migrationPhase("plan the auth schema")]);
  assert.equal(exit._tag, "Success");
  assert.deepEqual(lines, []);
  // Written as each step starts, so a job killed from outside still shows where it was.
  assert.deepEqual(steps, [
    "Migration step (attempt 1): open the database sessions",
    "Migration step (attempt 1): plan the auth schema",
  ]);
  assert.equal(calls, 1);
});

test("a lock timeout gets exactly one retry on a fresh attempt, with the phase and blockers reported", async () => {
  const blocked = migrationPhase("run the hosted product steps").pipe(Effect.andThen(Effect.fail(lockTimeout())));
  const { exit, lines, steps, calls } = await run([blocked, Effect.void]);
  assert.equal(exit._tag, "Success");
  assert.equal(calls, 2);
  assert.equal(steps.at(-1), "Migration step (attempt 2): open the database sessions");
  assert.deepEqual(lines, [
    'Cloud migration failed at "run the hosted product steps" (attempt 1 of 2): lock timeout (55P03)',
    "Blocker report: fixture",
    "Retrying in 1ms on fresh sessions",
  ]);
});

test("a second lock timeout fails the job naming the phase", async () => {
  const blocked = migrationPhase("apply the auth schema").pipe(Effect.andThen(Effect.fail(lockTimeout())));
  const { exit, calls } = await run([blocked, blocked, Effect.void]);
  assert.equal(calls, 2);
  const error = failure(exit);
  assert.equal(error._tag, "CloudMigrationStopped");
  assert.equal(error.message, 'Cloud migration failed at "apply the auth schema" (attempt 2 of 2): lock timeout (55P03)');
});

test("statement timeouts, connection failures and other errors are never retried", async () => {
  for (const [sqlState, reason] of [
    ["57014", "statement timeout or cancel (57014)"],
    ["08006", "product migration failed: SqlError (SQLSTATE 08006)"],
    [undefined, "product migration failed: SqlError"],
  ] as const) {
    const error = new HostedMigrationFailed({
      stage: "product",
      causeTags: ["SqlError"],
      ...(sqlState ? { sqlState } : {}),
    });
    const { exit, calls } = await run([Effect.fail(error), Effect.void]);
    assert.equal(calls, 1, `${sqlState} must not be retried`);
    assert.equal(failure(exit).reason, reason);
  }
});

test("a driver error deep in a cause chain keeps only its tags and SQLSTATE", async () => {
  const driver = Object.assign(new Error("password=secret host=private.example"), { code: "42P01" });
  const { exit, lines } = await run([Effect.fail({ _tag: "Wrapper", cause: driver })]);
  const error = failure(exit);
  assert.equal(error.reason, "Wrapper > Error (SQLSTATE 42P01)");
  assert.doesNotMatch(lines.join("\n"), /secret|private\.example/);
});

test("a defect is reported with its phase, and a Node error code is not a SQLSTATE", async () => {
  const broken = migrationPhase("close the database sessions").pipe(
    Effect.andThen(Effect.die(Object.assign(new Error("socket to private.example"), { code: "EPIPE" }))),
  );
  const { exit, lines, calls } = await run([broken, Effect.void]);
  assert.equal(calls, 1);
  assert.equal(failure(exit).message, 'Cloud migration failed at "close the database sessions" (attempt 1 of 2): Error');
  assert.deepEqual(lines.slice(1), ["Blocker report: fixture"]);
});

test("a stalled run stops at its deadline, names the phase it stalled in and is not retried", async () => {
  const stalled = migrationPhase("plan the auth schema").pipe(Effect.andThen(Effect.never));
  const started = Date.now();
  const { exit, lines, calls } = await run([stalled, Effect.void]);
  assert.ok(Date.now() - started < 2000);
  assert.equal(calls, 1);
  assert.equal(failure(exit).message, 'Cloud migration failed at "plan the auth schema" (attempt 1 of 2): did not finish within 200ms');
  assert.deepEqual(lines.slice(1), ["Blocker report: fixture"]);
});

test("a stalled run whose sessions cannot close still stops within its limits", async () => {
  // A dead connection's rollback or pool end can wait forever too.
  const stuck = migrationPhase("build the executor indexes").pipe(
    Effect.andThen(Effect.never),
    Effect.onInterrupt(() => Effect.never),
  );
  const started = Date.now();
  const { exit } = await run([stuck]);
  assert.ok(Date.now() - started < 2000);
  assert.equal(failure(exit).phase, "build the executor indexes");
});

test("a report that cannot finish does not hold the job", async () => {
  const { exit, lines } = await run([Effect.fail(lockTimeout()), Effect.fail(lockTimeout())], Effect.never);
  assert.equal(exit._tag, "Failure");
  assert.ok(lines.includes("Blocker report: timed out"));
  const broken = await run([Effect.fail(new HostedMigrationFailed({ stage: "auth" }))], Effect.fail(new Error("refused")) as never);
  assert.ok(broken.lines.includes("Blocker report: unavailable"));
});

test("a fingerprint keeps a statement's shape and drops every value", () => {
  assert.equal(
    queryFingerprint(`update "user" set "name" = 'Ada O''Neil', age = 37 where id = $1 -- by admin@example.com`),
    `update "user" set "name" = ?, age = ? where id = $1`,
  );
  assert.equal(queryFingerprint("select E'a\\'b', $tag$secret$tag$, $$x$$, 1.5e3 from effect_sql_1"), "select ?, ?, ?, ? from effect_sql_1");
  assert.equal(queryFingerprint("insert into t values ('truncated by track_activity_query_si"), "insert into t values (?");
  assert.equal(queryFingerprint("/* token=abc */ select 1"), "select ?");
  assert.equal(queryFingerprint("select .5, 0x1F, 1_000, 10, col2 from t1"), "select ?, ?, ?, ?, col2 from t1");
  assert.equal(queryFingerprint(null), "(none)");
  assert.equal(queryFingerprint(`select ${"x, ".repeat(100)}1`).length, 160);
});

test("report lines carry sessions and lock waits but no login names or addresses", () => {
  const lines = formatBlockerRows([
    {
      kind: "migration",
      pid: 10,
      blocks: null,
      state: "active",
      wait: "Lock:relation",
      waiting_for: 'relation AccessExclusiveLock on "oauthResource"',
      xact_age: 40,
      state_age: 39,
      application: "executor-deploy-job",
      same_login: true,
      query: `select * from "oauthResource" where "identifier" = $1`,
    },
    {
      kind: "blocker",
      pid: 11,
      blocks: 10,
      state: "idle in transaction",
      wait: "Client:ClientRead",
      waiting_for: null,
      xact_age: 300,
      state_age: 290,
      application: "app\u0000; person@example.com 'x'",
      same_login: false,
      query: "update \"user\" set email = 'person@example.com' where id = 'u_1'",
    },
  ]);
  assert.deepEqual(lines, [
    'Blocker report: deploy-job session pid 10: active, waiting on Lock:relation, for relation AccessExclusiveLock on oauthResource, transaction open 40s, in this state 39s, application executor-deploy-job, same login: select * from "oauthResource" where "identifier" = $1',
    'Blocker report: blocker pid 11 (blocks 10): idle in transaction, waiting on Client:ClientRead, transaction open 300s, in this state 290s, application (redacted), other login: update "user" set email = ? where id = ?',
  ]);
  assert.deepEqual(formatBlockerRows([]), ["Blocker report: no deploy-job sessions or open transactions"]);
});

test("every session sets its limits with plain SET, and the deploy command outlasts the job's worst case", () => {
  assert.deepEqual(migrationSessionSettings, [
    "set lock_timeout = '5s'",
    "set statement_timeout = '60s'",
    "set application_name = 'executor-deploy-job'",
  ]);
  assert.ok(Duration.toMillis(migrationLimits.read) > 60_000, "the client read limit must exceed statement_timeout");
  const worstCase = Duration.toMillis(migrationWorstCase);
  assert.equal(worstCase, 2 * (150 + 10 + 15) * 1000 + 2000);
  const infrastructure = readFileSync(resolve(upstream, "apps/hosted/cloud/src/infrastructure/database.ts"), "utf8");
  const timeouts = [...infrastructure.matchAll(/command: "node src\/migrate\.ts",[\s\S]*?timeout: "(\d+) minutes"/g)].map(
    (match) => Number(match[1]) * 60_000,
  );
  assert.equal(timeouts.length, 2, "both the production and the preview migration commands");
  // The job exits by itself at its hard limit, so the command's timeout, which drops stderr,
  // never fires first. Node startup and module loading come before the job's own clock starts.
  const hardLimit = Duration.toMillis(migrationHardLimit);
  assert.ok(hardLimit > worstCase);
  for (const timeout of timeouts) assert.ok(timeout >= hardLimit + 30_000, `${timeout}ms must exceed ${hardLimit}ms`);
  const job = readFileSync(resolve(upstream, "apps/hosted/cloud/src/migrate.ts"), "utf8");
  assert.match(job, /setTimeout\(\(\) => \{[\s\S]*process\.exit\(1\);\s*\}, Duration\.toMillis\(migrationHardLimit\)\)\.unref\(\)/);
});

test("Better Auth's own pool is bounded and its sessions get the same settings before any query", () => {
  const source = readFileSync(resolve(upstream, "apps/hosted/cloud/src/implementation/auth-provisioning.ts"), "utf8");
  for (const option of ["connectionTimeoutMillis:", "query_timeout:", "keepAlive: true", "keepAliveInitialDelayMillis:"]) assert.ok(source.includes(option), option);
  assert.match(source, /onConnect: \(client\) => client\.query\(migrationSessionSettings\.join\("; "\)\)/);
  assert.doesNotMatch(source, /statement_timeout:|lock_timeout:|options:/, "limits stay out of the startup packet");
});
