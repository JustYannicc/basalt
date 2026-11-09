import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { openEnvelope, signEnvelope, signPoolToken } from "./token.ts";
import { membershipPrefix, policyPrefix } from "./membership-contract.ts";

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
const workerModule = "./worker.ts";
const {
  PoolContainer,
}: {
  PoolContainer: new (ctx: object, env: object) => { fetch(request: Request): Promise<Response> };
} = await import(workerModule);
hooks.deregister();

const secret = "private-response-and-error-text";
const signingKey = "ab".repeat(32);
const claims = { pool: "guard-pool", organization: "guard-organization", owner: "guard-owner" };
const cases = [
  { fault: "membership_json", guard: "membership_body", failure: "invalid_body" },
  { fault: "membership_schema", guard: "membership_body", failure: "invalid_body" },
  {
    fault: "membership_status",
    guard: "membership_read",
    failure: "response_status",
    backendStatus: 502,
  },
  {
    fault: "reconciliation",
    guard: "reconciliation",
    failure: "response_status",
    backendStatus: 500,
  },
  {
    fault: "policy_status",
    guard: "native_policy_install",
    failure: "response_status",
    backendStatus: 409,
  },
  {
    fault: "policy_reason",
    guard: "native_policy_install",
    failure: "response_status",
    backendStatus: 400,
    reason: "lease_window",
    leaseMs: 15001,
  },
  {
    fault: "policy_framing",
    guard: "native_policy_install",
    failure: "response_status",
    backendStatus: 400,
    reason: "json",
  },
  {
    fault: "policy_unknown",
    guard: "native_policy_install",
    failure: "response_status",
    backendStatus: 400,
  },
  { fault: "policy_ack", guard: "native_policy_install", failure: "invalid_body" },
  { fault: "policy_transport", guard: "native_policy_install", failure: "transport" },
  {
    fault: "policy_renewal400",
    guard: "native_policy_install",
    failure: "response_status",
    backendStatus: 400,
  },
] as const;

for (const scenario of cases)
  test(`pool view names ${scenario.fault} without exposing backend text and recovers on retry`, async (t) => {
    const reports: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => reports.push(args));
    let fault = scenario.fault !== "policy_renewal400";
    let now = Date.now();
    if (scenario.fault === "policy_renewal400") t.mock.method(Date, "now", () => now);
    const values = new Map<string, unknown>();
    const background: Promise<unknown>[] = [];
    const worker = new PoolContainer(
      {
        waitUntil: (work: Promise<unknown>) => background.push(work),
        storage: {
          get: async (key: string) => structuredClone(values.get(key)),
          put: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
          },
          getAlarm: async () => null,
          setAlarm: async () => {},
        },
        container: {
          running: true,
          setInactivityTimeout: async () => {},
          destroy: async () => {},
          getTcpPort: (port: number) => ({
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              const request = new Request(input, init),
                path = new URL(request.url).pathname;
              if (port === 8318) {
                if (path !== "/native-policy")
                  return Response.json({
                    boot_id: "guard-boot",
                    started_at: "2026-11-09T00:00:00Z",
                  });
                if (fault && scenario.fault === "policy_transport") throw new Error(secret);
                if (fault && scenario.fault === "policy_status")
                  return new Response(secret, { status: 409 });
                if (
                  fault &&
                  ["policy_reason", "policy_unknown", "policy_framing"].includes(scenario.fault)
                )
                  return Response.json(
                    {
                      error:
                        scenario.fault === "policy_framing"
                          ? "invalid_projection_framing"
                          : "invalid_projection",
                      reason:
                        scenario.fault === "policy_reason"
                          ? "lease_window"
                          : scenario.fault === "policy_framing"
                            ? "json"
                            : secret,
                      accountIndex: 4,
                      leaseMs: 15001,
                      private: secret,
                    },
                    { status: 400 },
                  );
                if (fault && scenario.fault === "policy_renewal400")
                  return Response.json({ error: "invalid_projection", secret }, { status: 400 });
                if (fault && scenario.fault === "policy_ack")
                  return Response.json({ installed: true, revision: -1, secret });
                const { projection } = (await request.json()) as { projection: string };
                const policy = (await openEnvelope(signingKey, policyPrefix, projection)) as {
                  revision: number;
                };
                return Response.json({ installed: true, revision: policy.revision });
              }
              assert.equal(port, 8327);
              if (path.endsWith("/channel-groups")) {
                if (fault && scenario.fault === "reconciliation")
                  return new Response(secret, { status: 500 });
                return Response.json({
                  channel_groups: [{ id: 1, channel_name: `signalbox-pool-${claims.pool}` }],
                });
              }
              if (path.endsWith("/channel-group-details"))
                return Response.json({
                  channel_group_details: [{ id: 1, channel_group_id: 1, auth_id: "guard-account" }],
                });
              if (path.endsWith("/credentials"))
                return Response.json({
                  files: [{ id: "guard-account", provider: "codex", label: "Fixture" }],
                });
              if (path.includes("/quota/credentials/"))
                return Response.json({
                  credential: { credential_id: "guard-account", freshness: "fresh" },
                  windows: [],
                });
              assert.fail(`Unexpected management request ${path}`);
            },
          }),
        },
      },
      {
        POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/fixture",
        POOL_MANAGEMENT_KEY: "guard-management",
        POOL_APP_SIGNING_KEY: signingKey,
        POOL_IMAGE_HASH: "guard-image",
        TOOLS_SERVICE: {
          fetch: async (input: string) => {
            if (new URL(input).pathname.endsWith("/pool-organization"))
              return new Response(null, { status: 204 });
            if (fault && scenario.fault === "membership_status")
              return new Response(secret, { status: 502 });
            if (fault && scenario.fault === "membership_json") return new Response(secret);
            if (fault && scenario.fault === "membership_schema") return Response.json({ secret });
            return Response.json({
              pool: claims.pool,
              organization: claims.organization,
              native: true,
              accounts: [
                {
                  account: "guard-account",
                  requirement: "subscriptions",
                  provider: "codex",
                  method: "codex",
                  generation: 1,
                  driver: null,
                  driverRevision: null,
                  bindingRevision: null,
                  homeReference: "guard-account",
                },
              ],
            });
          },
        },
      },
    );
    const token = await signPoolToken(signingKey, claims);
    const read = () =>
      worker.fetch(
        new Request("https://pool.invalid/pool/v1/pool?fresh=true", {
          headers: { authorization: `Bearer ${token}`, "x-signalbox-caller": claims.owner },
        }),
      );
    if (scenario.fault === "policy_renewal400") {
      assert.equal((await read()).status, 200);
      fault = true;
      now += 2 * 60 * 60_000;
      const retained = await read();
      assert.equal(retained.status, 200, await retained.clone().text());
      assert.equal(((await retained.json()) as { accounts: unknown[] }).accounts.length, 1);
      assert.deepEqual(reports, [
        [
          "pool_guard_failure",
          {
            guard: "native_policy_install",
            failure: "response_status",
            backendStatus: 400,
          },
        ],
      ]);
      const reserved = await worker.fetch(
        new Request("https://pool.invalid/pool/v1/membership", {
          method: "POST",
          body: JSON.stringify({
            envelope: await signEnvelope(signingKey, membershipPrefix, {
              pool: claims.pool,
              organization: claims.organization,
              at: now,
              expiresAt: now + 30_000,
            }),
          }),
        }),
      );
      assert.equal(reserved.status, 503);
      reports.length = 0;
    }
    const failed = await read();
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), {
      error: "backend_unavailable",
      message: "The pool backend is unavailable. Try again later.",
    });
    const { fault: _fault, ...diagnostic } = scenario;
    assert.deepEqual(reports, [["pool_guard_failure", diagnostic]]);
    assert.ok(!JSON.stringify(reports).includes(secret));
    fault = false;
    const recovered = await read();
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal(((await recovered.json()) as { accounts: unknown[] }).accounts.length, 1);
    for (const work of background) await work;
  });
