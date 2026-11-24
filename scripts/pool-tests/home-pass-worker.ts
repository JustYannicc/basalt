import { registerHooks } from "node:module";
import { RuntimeMap } from "./runtime-map.ts";
import { membershipReadPath } from "../../src/pool/membership-contract.ts";

/** A pool controller with one clean native pool, whose native-policy installs a test can hold. */
export async function homePassWorker(options: { holdInstalls: () => Promise<void> | undefined }) {
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
  const workerModule = "../../src/pool/worker.ts";
  const {
    PoolContainer,
  }: {
    PoolContainer: new (ctx: object, env: object) => { alarm(): Promise<void> };
  } = await import(workerModule);
  const pool = "quiet-pool";
  const organization = "quiet-organization";
  const started = Date.now();
  let alarm: number | null = null;
  const storage = new Map<string, unknown>();
  const waitUntil: Promise<unknown>[] = [];
  storage.set("native-pool-memberships-v1", {
    [pool]: {
      pool,
      organization,
      revision: 1,
      expiresAt: started,
      accounts: ["account"],
      dirty: false,
      native: true,
      nativeConfirmed: true,
      checkedAt: started - 60_000,
      installedRevision: 1,
      installedUntil: started,
      installedGraceUntil: started + 24 * 60 * 60_000,
    },
  });
  const installs = { started: 0, inFlight: 0, maxInFlight: 0 };
  const container = {
    running: true,
    destroy: async () => {
      container.running = false;
    },
    start: () => {
      container.running = true;
    },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (port === 8318 && path === "/native-policy" && request.method === "POST") {
            const { projection } = (await request.json()) as { projection: string };
            const policy = JSON.parse(
              Buffer.from(projection.split(".")[1]!, "base64url").toString(),
            ) as { revision: number };
            installs.started++;
            installs.inFlight++;
            installs.maxInFlight = Math.max(installs.maxInFlight, installs.inFlight);
            try {
              await options.holdInstalls();
            } finally {
              installs.inFlight--;
            }
            return Response.json({ installed: true, revision: policy.revision });
          }
          if (port === 8318)
            return Response.json({ boot_id: "quiet-boot", started_at: "2026-11-22T00:00:00Z" });
          if (port === 8327) {
            const endpoint = path.slice("/v8/management".length);
            if (endpoint === "/channel-groups")
              return Response.json({
                channel_groups: [{ id: 20, channel_name: `signalbox-pool-${pool}` }],
              });
            if (endpoint.startsWith("/channel-group-details"))
              return Response.json({
                channel_group_details: [{ id: 1, channel_group_id: 20, auth_id: "account" }],
              });
            return Response.json({});
          }
          return new Response(null, { status: 404 });
        },
      };
    },
  };
  const tools = {
    fetch: async (input: string) =>
      new URL(input).pathname === membershipReadPath
        ? Response.json({
            pool,
            organization,
            native: true,
            accounts: [
              {
                account: "account",
                requirement: "requirement",
                provider: "codex",
                method: "oauth",
                generation: 1,
                driver: null,
                driverRevision: null,
                bindingRevision: null,
                homeReference: "account",
              },
            ],
          })
        : new Response(null, { status: 204 }),
  };
  const ctx = {
    id: { toString: () => "a".repeat(64) },
    container,
    abort: () => {},
    waitUntil: (work: Promise<unknown>) => {
      waitUntil.push(work);
    },
    storage: Object.assign(new RuntimeMap(storage), {
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
    }),
  };
  const worker = new PoolContainer(ctx, {
    TOOLS_SERVICE: tools,
    POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/fixture",
    POOL_MANAGEMENT_KEY: "fixture-management-key",
    POOL_AUTH_DATABASE: { connectionString: "postgres://fixture" },
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_IMAGE_HASH: "fixture-image",
  });
  return {
    worker,
    installs,
    started,
    settle: () => Promise.allSettled(waitUntil),
    close: () => hooks.deregister(),
  };
}
