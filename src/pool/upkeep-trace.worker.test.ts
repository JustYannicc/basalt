import { RuntimeMap } from "../../scripts/pool-tests/runtime-map.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { homeDatabasePoolReportMs } from "./home-database-pool.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    if (specifier === "pg")
      return {
        url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query() { return { rows: [] }; } async end() {} } }",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
// The Worker gets its platform declarations in tsconfig.worker.json.
const workerModule = "./worker.ts";
const {
  PoolContainer,
}: {
  PoolContainer: new (ctx: object, env: object) => { alarm(): Promise<void> };
} = await import(workerModule);
after(() => hooks.deregister());

interface Line {
  side: string;
  phase: string;
  outcome: string;
  elapsedMs: number;
  phases?: Record<string, number>;
  [field: string]: unknown;
}

/**
 * The upkeep lines of one real alarm whose fleet and Home deadlines are both due, with all it ran
 * beside it settled. An `aged` controller is built a report interval before the alarm, on a mocked
 * clock, so the minute's Home database pool read is due in it.
 */
async function runAlarm(context: TestContext, aged = false) {
  const lines: Line[] = [];
  context.mock.method(console, "info", (name: unknown, fields?: Line) => {
    if (name === "POOL_RUNTIME_UPKEEP") lines.push(fields!);
  });
  for (const method of ["log", "warn", "error"] as const)
    context.mock.method(console, method, () => {});
  const built = Date.now();
  if (aged) context.mock.timers.enable({ apis: ["Date"], now: built });
  const now = built + (aged ? homeDatabasePoolReportMs : 0);
  let alarm: number | null = null;
  // Both owners due, as when the fleet's 2 s deadline and Home's 5 s one meet on one alarm.
  const storage = new Map<string, unknown>([
    ["pool-alarm-v1:deadlines", { home: now, fleet: now }],
    // Plan allowances read the public sources only when due; this pass finds them fresh.
    ["pool-plan-allowances-v1", { nextAttemptAt: now + 60_000, sources: {} }],
  ]);
  const beside: Promise<unknown>[] = [];
  const container = {
    running: true,
    destroy: async () => {},
    start: () => {},
    setInactivityTimeout: async () => {},
    getTcpPort: (port: number) => ({
      fetch: async (input: RequestInfo | URL) => {
        if (port === 8318)
          return Response.json({ boot_id: "quiet-boot", started_at: "2026-11-22T00:00:00Z" });
        // An empty Home: no pool groups, so its usage reads find nothing to collect.
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        if (aged && path.endsWith("/capabilities"))
          return Response.json({
            server_info: { database_pool: { in_use: 2, wait_count: 5, wait_duration_ns: 7_000 } },
          });
        if (path.endsWith("/channel-groups")) return Response.json({ channel_groups: [] });
        if (path.includes("/channel-group-details"))
          return Response.json({ channel_group_details: [] });
        return Response.json({});
      },
    }),
  };
  const ctx = {
    id: { toString: () => "a".repeat(64) },
    container,
    abort: () => {},
    waitUntil: (work: Promise<unknown>) => {
      beside.push(work);
    },
    storage: Object.assign(new RuntimeMap(storage), {
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
    }),
  };
  const worker = new PoolContainer(ctx, {
    TOOLS_SERVICE: { fetch: async () => new Response(null, { status: 204 }) },
    POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/fixture",
    POOL_MANAGEMENT_KEY: "fixture-management-key",
    POOL_AUTH_DATABASE: { connectionString: "postgres://fixture" },
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_IMAGE_HASH: "fixture-image",
  });
  if (aged) context.mock.timers.tick(homeDatabasePoolReportMs);
  await worker.alarm();
  for (let settled = 0; settled < beside.length;) {
    const fresh = beside.slice(settled);
    settled = beside.length;
    await Promise.allSettled(fresh);
  }
  return { lines, now };
}

test("an alarm that runs the fleet and Home writes one alarm line and one Home line, each with every phase's time", async (context) => {
  const { lines, now } = await runAlarm(context);
  const alarmLines = lines.filter((line) => line.side === "alarm");
  assert.equal(alarmLines.length, 1, "one line for the alarm pass, none per phase");
  const [pass] = alarmLines;
  assert.equal(pass!.phase, "alarm");
  assert.equal(pass!.outcome, "ended");
  assert.deepEqual(Object.keys(pass!.phases!).sort(), ["fleet", "rearm"]);
  assert.ok(Object.values(pass!.phases!).every((ms) => Number.isInteger(ms) && ms >= 0));
  assert.equal(pass!.homeDue, true);
  assert.equal(pass!.fleetDue, true);
  assert.equal(pass!.homeDeadline, now, "the deadlines the alarm woke to");
  for (const next of ["nextHomeDeadline", "nextFleetDeadline", "nextNativeDeadline"])
    assert.ok(next in pass!, `and the ones it armed next: ${next}`);

  const home = lines.filter((line) => line.side === "home");
  assert.deepEqual(
    home.map((line) => [line.phase, line.outcome]),
    [["home", "ended"]],
    "one line for the Home pass, none per phase",
  );
  const phases = home[0]!.phases!;
  for (const phase of [
    "candidate_probe",
    "primary_retirement",
    "app_models",
    "memberships",
    "computers",
    "warm",
    "first_request",
    "control",
    "prices",
    "overview_prices",
    "usage",
    "accounts",
  ])
    assert.ok(Number.isInteger(phases[phase]), `the Home line times ${phase}`);
  assert.ok(Object.values(phases).includes(0), "a phase that took no time is there with 0");
});

test("once its report interval has passed, the controller's Home database pool read is a Home pass of its own", async (context) => {
  const { lines } = await runAlarm(context, true);
  const home = lines.filter((line) => line.side === "home");
  assert.deepEqual(home.map((line) => line.phase).sort(), ["home", "home_database_pool"]);
  const [pool] = home.filter((line) => line.phase === "home_database_pool");
  assert.equal(pool!.outcome, "ended");
  assert.deepEqual(pool!.phases, {});
  assert.deepEqual(pool!.homeDatabasePool, {
    inUse: 2,
    waitCount: 5,
    waitDurationNs: 7_000,
    ageMs: 0,
  });
});
