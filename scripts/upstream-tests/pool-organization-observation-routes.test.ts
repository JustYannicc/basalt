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
  seed,
  signingKey,
  wouldRefuse,
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

const refusal = JSON.stringify({
  error: "unauthorized",
  message: "This organization is no longer available.",
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
  readonly checks: readonly Answer[];
  readonly membershipReads: readonly string[];
}

/**
 * One request to a fresh pool Worker. `observed` answers the organization check with the real tools
 * handler over the seeded database; otherwise with 204, the answer today's check gives any existing
 * organization, so both runs differ only in the handler under test.
 */
async function visit(route: string, caller: string, stored: boolean, observed: boolean) {
  const token = await signPoolToken(signingKey, {
    pool,
    owner: caller,
    organization: caller === "person-owner" ? person : caller,
  });
  const now = Date.now();
  const values = new Map<string, unknown>();
  if (stored)
    values.set("native-pool-memberships-v1", {
      [pool]: {
        pool,
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
  const worker = new PoolContainer(
    {
      id: { toString: () => "a".repeat(64) },
      container: {
        running: false,
        start() {
          this.running = true;
        },
        destroy: async () => {},
        setInactivityTimeout: async () => {},
        // A ready runtime whose Home answers nothing useful: routes fail fast after the check.
        getTcpPort: (port: number) => ({
          fetch: async () =>
            port === 8318
              ? Response.json({ boot_id: "fixture-boot", started_at: "2026-11-01T00:00:00Z" })
              : Response.json({ error: "fixture" }, { status: 500 }),
        }),
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
            if (!observed) return new Response(null, { status: 204 });
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
            pool,
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
      headers: { authorization: `Bearer ${token}`, "x-signalbox-caller": caller },
    }),
  );
  // Two runs of a pair answer moments apart: setup intents expire, and capacity windows end, at the
  // request's own clock. Everything else in an answer must match byte for byte.
  const body = (await response.text())
    .replace(/sbci1\.[\w-]+\.[\w-]+/g, "sbci1.<intent>")
    .replace(/"to":\d{13},/, '"to":"<now>",');
  // What the request itself read, before any background work it started.
  const reads = [...membershipReads];
  for (let settled = 0; settled < background.length;) {
    const pending = background.slice(settled);
    settled = background.length;
    await Promise.allSettled(pending);
  }
  return { status: response.status, body, checks, membershipReads: reads } satisfies Visit;
}

const database = () =>
  seed({
    organizations: {
      [person]: { basaltPools: { [pool]: { app: pool, version: "dpl_1", owner: "person-owner" } } },
      acceptance: {},
      org_other: {},
    },
    apps: { [pool]: { owner: owned(person) } },
  });

for (const organization of ["acceptance", "org_other"])
  for (const stored of [false, true])
    test(`an ${organization} token on a person's pool, ${stored ? "with" : "without"} membership state, keeps today's answer on every route and reports other-organization`, async () => {
      await database();
      for (const route of routes) {
        const today = await visit(route, organization, stored, false);
        const observed = await visit(route, organization, stored, true);
        assert.deepEqual(
          { status: observed.status, body: observed.body },
          { status: today.status, body: today.body },
          `${route} keeps today's answer`,
        );
        assert.notEqual(observed.body, refusal, `${route} is not refused by the check`);
        assert.deepEqual(
          observed.checks,
          [{ status: 204, lines: [wouldRefuse(organization, "other-organization")] }],
          `${route} reports the pool once`,
        );
        assert.deepEqual(
          observed.membershipReads,
          today.membershipReads,
          `${route} reads membership as today`,
        );
      }
    });

test("a request the ownership rule would refuse still reaches its route today", async () => {
  await database();
  // Past the check, a control read without membership state asks the host for the token's organization.
  const read = await visit("/pool/v1/pool", "acceptance", false, true);
  assert.deepEqual(read.checks, [
    { status: 204, lines: [wouldRefuse("acceptance", "other-organization")] },
  ]);
  assert.deepEqual(read.membershipReads, ["acceptance"]);
  assert.notEqual(read.body, refusal);
});

test("the person's own token passes the same check silently", async () => {
  await database();
  for (const stored of [false, true])
    for (const route of routes) {
      const observed = await visit(route, "person-owner", stored, true);
      assert.deepEqual(observed.checks, [{ status: 204, lines: [] }], route);
      assert.notEqual(observed.body, refusal, route);
    }
});
