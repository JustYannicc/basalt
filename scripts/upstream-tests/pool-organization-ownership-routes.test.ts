import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { RuntimeMap } from "../pool-tests/runtime-map.ts";
import { membershipReadPrefix } from "../../src/pool/membership-contract.ts";
import { openEnvelope, signPoolToken } from "../../src/pool/token.ts";
import {
  type Answer,
  answer,
  owned,
  person,
  pool,
  refused,
  seed,
  signingKey,
} from "./pool-organization-fixture.ts";

// Node has no Workers runtime; keep the real pool Worker with its platform adapters stubbed.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    if (specifier === "pg")
      return {
        url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query() { return { rows: [{ active: false }] }; } async end() {} } }",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const workerModule = "../../src/pool/worker.ts";
const {
  PoolContainer,
}: {
  PoolContainer: new (ctx: object, env: object) => { fetch(request: Request): Promise<Response> };
} = await import(workerModule);
hooks.deregister();

// What a caller of the pool sees: the pool Worker's answer to the tools service's 403, and to
// anything else that is not 204.
const refusal = JSON.stringify({
  error: "unauthorized",
  message: "This organization is no longer available.",
});
const unavailableBody = JSON.stringify({
  error: "backend_unavailable",
  message: "The pool backend is unavailable. Try again later.",
});
// The pool's control reads, then the reads that run before membership is checked.
const routes = [
  "/pool/v1/pool",
  "/pool/v1/usage",
  "/pool/v1/usage/history?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z",
  "/pool/v1/usage/capacity",
  "/pool/v1/computers",
  "/pool/v1/setup-context",
];

interface Visit {
  readonly status: number;
  readonly body: string;
  readonly headers: Headers;
  readonly checks: readonly Answer[];
  readonly membershipReads: readonly string[];
  /** Calls that reached the pool's container: a start or a port. */
  readonly containerCalls: number;
}

interface Caller {
  readonly owner: string;
  readonly organization: string;
  readonly pool?: string;
}

/**
 * One request to a fresh pool Worker. The organization check is the real tools handler over the
 * seeded database, or, when `hang`, a tools service that never answers until the Worker gives up.
 */
async function visit(route: string, caller: Caller, stored: boolean, hang = false) {
  const target = caller.pool ?? pool;
  const token = await signPoolToken(signingKey, {
    pool: target,
    owner: caller.owner,
    organization: caller.organization,
  });
  const now = Date.now();
  const values = new Map<string, unknown>();
  if (stored)
    values.set("native-pool-memberships-v1", {
      [target]: {
        pool: target,
        organization: person,
        revision: 1,
        expiresAt: now + 3_600_000,
        accounts: [],
        dirty: false,
        native: true,
        nativeConfirmed: true,
        checkedAt: now,
        installedRevision: 1,
        installedUntil: now + 3_600_000,
      },
    });
  const checks: Answer[] = [];
  const membershipReads: string[] = [];
  const background: Promise<unknown>[] = [];
  let containerCalls = 0;
  const worker = new PoolContainer(
    {
      id: { toString: () => "a".repeat(64) },
      container: {
        running: false,
        start() {
          containerCalls += 1;
          this.running = true;
        },
        destroy: async () => {},
        setInactivityTimeout: async () => {},
        // A ready runtime whose Home answers nothing useful: routes fail fast after the check.
        getTcpPort: (port: number) => {
          containerCalls += 1;
          return {
            fetch: async () =>
              port === 8318
                ? Response.json({ boot_id: "fixture-boot", started_at: "2026-11-01T00:00:00Z" })
                : Response.json({ error: "fixture" }, { status: 500 }),
          };
        },
      },
      waitUntil: (work: Promise<unknown>) => {
        background.push(work);
      },
      storage: Object.assign(new RuntimeMap(values), {
        getAlarm: async () => null,
        setAlarm: async () => {},
      }),
    },
    {
      POOL_DATABASE_URL: "postgres://fixture",
      POOL_MANAGEMENT_KEY: "fixture",
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_IMAGE_HASH: "fixture",
      POOL_MODEL_HISTORY_ENABLED: "false",
      TOOLS_SERVICE: {
        fetch: async (url: string, init: RequestInit) => {
          const path = new URL(url).pathname;
          if (path === "/api/internal/pool-organization") {
            if (hang)
              return new Promise<Response>((_, reject) =>
                init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
              );
            const checked = await answer(String(init.body));
            checks.push(checked);
            return new Response(null, { status: checked.status });
          }
          assert.equal(path, "/api/internal/pool-membership");
          const { envelope } = JSON.parse(String(init.body)) as { envelope: string };
          const read = (await openEnvelope(signingKey, membershipReadPrefix, envelope)) as {
            organization: string;
          };
          membershipReads.push(read.organization);
          // The host's membership read: only the owning organization is native.
          return Response.json({
            pool: target,
            organization: read.organization,
            native: read.organization === person,
            accounts: [],
          });
        },
      },
    },
  );
  const response = await worker.fetch(
    new Request(`https://pool.example${route}`, {
      headers: { authorization: `Bearer ${token}`, "x-signalbox-caller": caller.owner },
    }),
  );
  const body = await response.text();
  // What the request itself read, before any background work it started.
  const reads = [...membershipReads];
  const calls = containerCalls;
  for (let settled = 0; settled < background.length;) {
    const pending = background.slice(settled);
    settled = background.length;
    await Promise.allSettled(pending);
  }
  return {
    status: response.status,
    body,
    headers: response.headers,
    checks,
    membershipReads: reads,
    containerCalls: calls,
  } satisfies Visit;
}

const database = () =>
  seed({
    organizations: {
      [person]: { basaltPools: { [pool]: { app: pool, version: "dpl_1", owner: "person-owner" } } },
      acceptance: {},
      org_other: {},
      org_unreadable: "{not json",
    },
    apps: {
      [pool]: { owner: owned(person) },
      app_unreadable_pool: { owner: owned("org_unreadable") },
    },
  });

const own = { owner: "person-owner", organization: person } satisfies Caller;

for (const organization of ["acceptance", "org_other"])
  for (const stored of [false, true])
    test(`an ${organization} token on a person's pool, ${stored ? "with" : "without"} membership state, is refused on every route before it runs`, async () => {
      await database();
      for (const route of routes) {
        const visited = await visit(route, { owner: organization, organization }, stored);
        assert.deepEqual(
          { status: visited.status, body: visited.body },
          { status: 403, body: refusal },
          route,
        );
        assert.equal(visited.headers.get("cache-control"), "no-store", route);
        assert.equal(visited.headers.get("retry-after"), null, route);
        assert.deepEqual(
          visited.checks,
          [{ status: 403, lines: [refused(organization, "other-organization")] }],
          `${route} is checked once and names the shape`,
        );
        assert.deepEqual(visited.membershipReads, [], `${route} never reads membership`);
        assert.equal(visited.containerCalls, 0, `${route} never touches the container`);
      }
    });

test("the person's own token passes the same check silently on every route", async () => {
  await database();
  for (const stored of [false, true])
    for (const route of routes) {
      const visited = await visit(route, own, stored);
      assert.deepEqual(visited.checks, [{ status: 204, lines: [] }], route);
      // Past the check the route runs, against a fixture Home that answers nothing useful.
      assert.notEqual(visited.body, refusal, route);
    }
});

test("an organization whose metadata cannot be read gets the pool's unavailable answer, never the refusal", async () => {
  await database();
  const unreadable = { owner: "person-owner", organization: "org_unreadable" };
  const visited = await visit(
    "/pool/v1/pool",
    { ...unreadable, pool: "app_unreadable_pool" },
    false,
  );
  assert.deepEqual(
    { status: visited.status, body: visited.body },
    { status: 503, body: unavailableBody },
  );
  assert.equal(visited.checks[0]?.status, 503);
  assert.equal(visited.containerCalls, 0);
  // The person's pool in the same database is untouched by it.
  assert.deepEqual((await visit("/pool/v1/pool", own, false)).checks, [{ status: 204, lines: [] }]);
});

test("a check the tools service never answers ends at the pool Worker's 10 s as its unavailable answer", async () => {
  await database();
  const timeout = AbortSignal.timeout;
  const asked: number[] = [];
  // The Worker's own bound, shortened here only so the test need not wait it out.
  AbortSignal.timeout = (ms: number) => {
    asked.push(ms);
    return timeout.call(AbortSignal, 20);
  };
  try {
    const visited = await visit("/pool/v1/pool", own, false, true);
    assert.equal(asked[0], 10_000, "the check waits the Worker's 10 s, past the database's 8 s");
    assert.deepEqual(
      { status: visited.status, body: visited.body },
      { status: 503, body: unavailableBody },
    );
    assert.equal(visited.containerCalls, 0);
  } finally {
    AbortSignal.timeout = timeout;
  }
});
