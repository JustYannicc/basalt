import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { ProbeResult } from "./availability.ts";
import { fixture, signingKey } from "./test/control.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const modulePath = "./worker.ts";
const {
  PoolContainer,
  PoolOperations,
  default: worker,
}: {
  PoolContainer: new (
    ctx: object,
    env: object,
  ) => {
    availabilityProbe(pool: string): Promise<ProbeResult>;
    automaticRecoveryObservation(pool: string): Promise<unknown>;
  };
  PoolOperations: {
    prototype: { fetch(this: { env: object }, request: Request): Promise<Response> };
  };
  default: {
    scheduled(event: { cron: string }, env: object): Promise<void>;
    fetch(request: Request, env: object): Promise<Response>;
  };
} = await import(modulePath);
hooks.deregister();

test("the scheduled Worker keeps its passive probe and reports unavailable history without warming or repair", async (t) => {
  const f = await fixture();
  f.home.addFile("auth-a");
  f.home.addGroup("fixture-pool", 1, ["auth-a"]);
  const native: string[] = [];
  const messages: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    messages.push(new TextDecoder().decode(init?.body as ArrayBuffer));
    return new Response(null, { status: 202 });
  });
  const state = {
    pool: "fixture-pool",
    organization: "fixture-org",
    revision: 1,
    native: true,
    dirty: false,
    accounts: ["auth-a"],
    expiresAt: Date.now() + 15000,
    installedUntil: Date.now() + 15000,
    installedRevision: 1,
    checkedAt: Date.now(),
  };
  let probeTarget: string | undefined;
  const env = {
    POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/basalt_pool",
    POOL_MANAGEMENT_KEY: "management-fixture",
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_IMAGE_HASH: "fixture-image",
    POOL_AVAILABILITY_TARGET: state.pool,
    POOL_MODEL_HISTORY_ENABLED: "false",
    SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
    PoolContainer: {
      jurisdiction(region: string) {
        assert.equal(region, "eu");
        return {
          getByName(name: string) {
            assert.equal(name, "control-plane");
            return {
              availabilityProbe(pool: string) {
                probeTarget = pool;
                return object.availabilityProbe(pool);
              },
              automaticRecoveryObservation(pool: string) {
                return object.automaticRecoveryObservation(pool);
              },
            };
          },
        };
      },
    },
  };
  const object = new PoolContainer(
    {
      id: { toString: () => "a".repeat(64) },
      container: {
        running: true,
        setInactivityTimeout: async () => {},
        start: () => assert.fail("probe warmed compute"),
        destroy: () => assert.fail("probe destroyed compute"),
        getTcpPort(port: number) {
          return {
            async fetch(input: string | Request, init?: RequestInit) {
              const request = new Request(input, init);
              const url = new URL(request.url);
              if (port === 8327) {
                assert.equal(request.method, "GET");
                return f.home.fetch(url.pathname + url.search, { method: request.method });
              }
              assert.equal(port, 8318);
              native.push(url.pathname);
              if (url.pathname === "/ready")
                return Response.json(
                  { boot_id: "fixture-boot", started_at: "fixture-start" },
                  { headers: { "X-Signalbox-Policy-Lease-Ms": "1500" } },
                );
              assert.equal(url.pathname, "/native-policy/check");
              return Response.json({ ok: true });
            },
          };
        },
      },
      waitUntil: () => {},
      storage: {
        get: async (key: string) =>
          key === "native-pool-memberships-v1"
            ? { [state.pool]: structuredClone(state) }
            : undefined,
        put: async () => assert.fail("probe wrote storage"),
        getAlarm: async () => null,
        setAlarm: async () => assert.fail("probe changed alarms"),
      },
    },
    env,
  );
  await worker.scheduled({ cron: "* * * * *" }, env);
  assert.equal(probeTarget, state.pool);
  assert.ok(f.home.calls.some((call) => call.path.endsWith("/quota/credentials/auth-a")));
  assert.deepEqual(native.sort(), ["/native-policy/check", "/ready"]);
  assert.equal(
    f.home.calls.every((call) => call.method === "GET"),
    true,
  );
  assert.equal(messages.length, 3);
  assert.match(messages[1]!, /"status":"error"/);
  assert.match(messages[2]!, /pool_request_collection_unavailable/);
  const report = await PoolOperations.prototype.fetch.call(
    { env },
    new Request(`https://operations/availability?pool=${state.pool}`),
  );
  assert.equal(report.status, 200);
  assert.equal(report.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await report.json(), { ok: true, failures: [] });
  assert.equal(messages.length, 3, "manual reads never send check-ins or change monitoring");
  const automatic = await PoolOperations.prototype.fetch.call(
    { env },
    new Request(`https://operations/automatic-recovery-observation?pool=${state.pool}`),
  );
  assert.equal(automatic.status, 200);
  assert.equal(automatic.headers.get("Cache-Control"), "no-store");
  const observed = await automatic.json();
  assert.equal(observed.enabled, false);
  assert.equal(observed.condition, "healthy");
  assert.equal(observed.runtime.bootId, "fixture-boot");
  assert.equal(observed.runtime.instanceId, "a".repeat(64));
  assert.equal(messages.length, 3);
  assert.equal(
    (
      await worker.fetch(
        new Request(`https://public/automatic-recovery-observation?pool=${state.pool}`),
        env,
      )
    ).status,
    404,
  );
});
