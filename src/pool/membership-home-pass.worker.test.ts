import { RuntimeMap } from "../../scripts/pool-tests/runtime-map.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { membershipReadPath, membershipRefreshMs, membershipTtlMs } from "./membership-contract.ts";
import { observationPublishPath } from "./account-observation-publish.ts";

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

const pool = "quiet-pool";
const organization = "quiet-organization";
const payload = (envelope: string) =>
  JSON.parse(Buffer.from(envelope.split(".")[1]!, "base64url").toString()) as {
    revision: number;
    expiresAt: number;
  };

test("every five-second alarm renews the native lease while an earlier Home pass is still in a report", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-22T12:00:00Z") });
  const joined: number[] = [];
  t.mock.method(console, "info", (label: unknown, fields?: { phase?: string }) => {
    if (label === "POOL_RUNTIME_UPKEEP" && fields?.phase === "home_shared") joined.push(Date.now());
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
  const started = Date.now();
  let alarm: number | null = null;
  const storage = new Map<string, unknown>();
  const waitUntil: Promise<unknown>[] = [];
  // A clean acknowledged native pool, as a live controller holds it between calls.
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
  const installs: { at: number; revision: number; expiresAt: number }[] = [];
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
            const policy = payload(((await request.json()) as { projection: string }).projection);
            installs.push({ at: Date.now(), ...policy });
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
  // The account-observation report runs every five minutes inside the Home pass, after the
  // membership pass, with a 30 s budget. This one takes as long as the test holds it.
  let release!: () => void;
  let entered!: () => void;
  const reportEntered = new Promise<void>((done) => {
    entered = done;
  });
  const held = new Promise<Response>((done) => {
    release = () => done(new Response(null, { status: 204 }));
  });
  const tools = {
    fetch: async (input: string) => {
      const path = new URL(input).pathname;
      if (path === membershipReadPath)
        return Response.json({
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
        });
      if (path === observationPublishPath) {
        entered();
        return held;
      }
      return new Response(null, { status: 204 });
    },
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
  let settledThrough = 0;
  const settleNew = async () => {
    for (let pass = 0; pass < 20; pass++) {
      const fresh = waitUntil.slice(settledThrough);
      settledThrough = waitUntil.length;
      await Promise.allSettled(fresh);
      await new Promise<void>((done) => setImmediate(done));
      if (waitUntil.length === settledThrough) return;
    }
  };
  try {
    await worker.alarm();
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      reportEntered.then(() => "entered" as const),
      new Promise<"absent">((done) => {
        guard = setTimeout(() => done("absent"), 5_000);
      }),
    ]);
    clearTimeout(guard);
    assert.equal(outcome, "entered", "precondition: the Home pass reaches its report");
    assert.equal(installs.length, 1, "precondition: the Home pass renewed the lease once");
    // The held Home pass is the first entry; everything after it must settle on its own.
    settledThrough = waitUntil.length;
    for (const at of [membershipRefreshMs, 2 * membershipRefreshMs]) {
      t.mock.timers.setTime(started + at);
      await worker.alarm();
      await settleNew();
    }
    assert.equal(joined.length, 2, "precondition: both later alarms found Home upkeep due");
    t.mock.timers.setTime(started + membershipTtlMs);
    const lease = installs.at(-1)!;
    assert.ok(
      lease.expiresAt > Date.now(),
      `the native lease installed at +${lease.at - started} ms expired at +${lease.expiresAt - started} ms while one report held the Home pass; ${installs.length} install(s) in ${membershipTtlMs} ms`,
    );
  } finally {
    release();
    await Promise.allSettled(waitUntil);
  }
});
