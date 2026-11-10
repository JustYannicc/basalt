import { RuntimeSqlite } from "./runtime-handoff-storage.ts";
import { runtimeFixtureCode } from "./runtime-handoff-proofs.ts";
import assert from "node:assert/strict";
import { Schema } from "effect";
import {
  RuntimeEndpoint,
  type EndpointEnvironment,
} from "../../src/pool/runtime-slots/endpoint.ts";
import { runtimeRequest } from "../../src/pool/runtime-slots/transport.ts";
import {
  configurationDigest,
  runtimeConfiguration,
  type StartupOptions,
} from "../../src/pool/runtime-slots/configuration.ts";
import type { SlotIdentity, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import { launchTokenHash } from "../../src/pool/launch-ledger.ts";
import {
  launchGenerationHeader,
  launchTokenHashHeader,
  policyHealthHeader,
} from "../../src/pool/runtime-health.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import {
  policyPrefix,
  policyUsePrefix,
  type NativeMembershipPolicy,
} from "../../src/pool/membership-contract.ts";
import { fixture, signingKey } from "../../src/pool/test/control.ts";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const Policy = Schema.Struct({
  pool: Schema.String,
  organization: Schema.String,
  revision: Schema.Number,
  expiresAt: Schema.Number,
  accounts: Schema.Array(Schema.String),
  dirty: Schema.Boolean,
});
const Assertion = Schema.Struct({
  pool: Schema.String,
  revision: Schema.Number,
  expiresAt: Schema.Number,
});

export async function handoffRuntime(
  target: SlotTarget,
  env: EndpointEnvironment,
  options: {
    running?: boolean;
    storage?: RuntimeSqlite;
    role?: "legacy" | "runtime";
    home?: Awaited<ReturnType<typeof fixture>>["home"];
  } = {},
) {
  const home = options.home ?? (await fixture()).home;
  if (!options.home) {
    home.addFile("auth-a");
    home.addGroup("pool-a", 1, ["auth-a"]);
  }
  const storage = options.storage ?? new RuntimeSqlite();
  const background: Promise<unknown>[] = [];
  const calls = {
    start: 0,
    destroy: 0,
    keepAlive: 0,
    health: 0,
    home: 0,
    model: 0,
    install: [] as NativeMembershipPolicy[],
  };
  let running = options.running ?? false,
    bootId = crypto.randomUUID();
  let startup: StartupOptions = {
    enableInternet: true,
    env: {
      POOL_MANAGEMENT_KEY: env.POOL_MANAGEMENT_KEY,
      POOL_APP_SIGNING_KEY: env.POOL_APP_SIGNING_KEY,
    },
  };
  const policies = new Map<string, NativeMembershipPolicy>();
  const hooks = {
    health: async () => {},
    install: async (_policy: NativeMembershipPolicy) => {},
    model: async (_request: Request): Promise<Response | undefined> => undefined,
  };
  const ctx = {
    id: { toString: () => target.instanceId },
    storage,
    waitUntil: (work: Promise<unknown>) => {
      background.push(work);
    },
    container: {
      get running() {
        return running;
      },
      start(value: StartupOptions) {
        calls.start++;
        startup = value;
        running = true;
        bootId = crypto.randomUUID();
      },
      async destroy() {
        calls.destroy++;
        running = false;
      },
      setInactivityTimeout: async () => {
        calls.keepAlive++;
      },
      getTcpPort(port: number) {
        return {
          fetch: async (input: string | Request, init?: RequestInit) => {
            const request = new Request(input, init),
              url = new URL(request.url);
            if (port === 8318) {
              assert.equal(
                request.headers.get("Authorization"),
                `Bearer ${startup.env.POOL_MANAGEMENT_KEY}`,
              );
              if (url.pathname === "/ready") {
                calls.health++;
                await hooks.health();
                request.signal.throwIfAborted();
                const headers = new Headers({ [policyHealthHeader]: "1500" });
                if (startup.env.POOL_LAUNCH_GENERATION) {
                  headers.set(launchGenerationHeader, startup.env.POOL_LAUNCH_GENERATION);
                  headers.set(
                    launchTokenHashHeader,
                    await launchTokenHash(startup.env.POOL_LAUNCH_TOKEN!),
                  );
                }
                return Response.json(
                  { boot_id: bootId, started_at: "fixture-started" },
                  { headers },
                );
              }
              if (url.pathname === "/native-policy") {
                const { projection } = Schema.decodeUnknownSync(
                  Schema.Struct({ projection: Schema.String }),
                )(await request.json());
                const policy = Schema.decodeUnknownSync(Policy)(
                  await openEnvelope(startup.env.POOL_APP_SIGNING_KEY!, policyPrefix, projection),
                );
                await hooks.install(policy);
                const previous = policies.get(policy.pool);
                assert.ok(!previous || previous.revision <= policy.revision);
                policies.set(policy.pool, policy);
                calls.install.push(policy);
                return Response.json({ installed: true, revision: policy.revision });
              }
              assert.equal(url.pathname, "/native-policy/check");
              const { assertion } = Schema.decodeUnknownSync(
                Schema.Struct({ assertion: Schema.String }),
              )(await request.json());
              const value = Schema.decodeUnknownSync(Assertion)(
                await openEnvelope(startup.env.POOL_APP_SIGNING_KEY!, policyUsePrefix, assertion),
              );
              const policy = policies.get(value.pool);
              return Response.json({
                ok:
                  !!policy &&
                  !policy.dirty &&
                  policy.revision === value.revision &&
                  value.expiresAt > Date.now(),
              });
            }
            if (port === 8327) {
              calls.home++;
              assert.equal(
                request.headers.get("X-Management-Key"),
                startup.env.POOL_MANAGEMENT_KEY,
              );
              return home.fetch(url.pathname + url.search, {
                method: request.method,
                headers: request.headers,
                signal: request.signal,
                ...(request.body ? { body: await request.text() } : {}),
              });
            }
            assert.equal(port, 8317);
            calls.model++;
            return (await hooks.model(request)) ?? Response.json({ data: [{ id: bootId }] });
          },
        };
      },
    },
  };
  const endpoint = new RuntimeEndpoint(ctx, env, options.role ?? "runtime", runtimeFixtureCode);
  return {
    ctx,
    env,
    target,
    home,
    calls,
    hooks,
    policies,
    endpoint,
    storage,
    identity: (): SlotIdentity => ({ ...target, bootId }),
    digest: () => configurationDigest(runtimeConfiguration(env)),
    stub: { fetch: (request: Request) => runtimeRequest(request, endpoint) },
    cleanup: async () => {
      for (let index = 0; index < background.length; index++) await background[index];
      await storage.close();
    },
    signingKey,
    crash: () => {
      running = false;
    },
    replaceBoot: () => {
      bootId = crypto.randomUUID();
    },
  };
}
