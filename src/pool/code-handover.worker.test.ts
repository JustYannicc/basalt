import { RuntimeMap } from "../../scripts/pool-tests/runtime-map.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { appModelPath } from "./app-model-contract.ts";
import { codeHandoverHeader } from "./code-handover.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { productionOpsRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    if (specifier === "pg")
      return {
        url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query(text, values) { return { rows: text.includes('SELECT k.id') ? [{ id: 73, channels: [], username: null }] : [{ active: false }] }; } async end() {} } }",
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
  PoolContainer: new (
    ctx: object,
    env: object,
  ) => {
    alarm(): Promise<void>;
    fetch(request: Request): Promise<Response>;
    deploymentIdentity(caller?: unknown): { candidate: string };
  };
} = await import(workerModule);
after(() => hooks.deregister());

test("a different deployed code hands the controller over: model calls are refused before the runtime, the object resets once, and the container keeps its boot", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-21T14:00:00Z") });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  let alarm: number | null = null;
  const storage = new Map<string, unknown>();
  const waitUntil: Promise<unknown>[] = [];
  const pool = "fake-pool";
  storage.set("computer-registry-v1", {
    "computer-73": {
      id: "computer-73",
      name: "Fixture",
      user: "response-owner",
      pool,
      createdAt: "2026-01-01T00:00:00.000Z",
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "active",
      keyId: 73,
      userId: 1,
      toolsKeyId: "tools-key-73",
      toolsHash: "tools-hash-73",
      firstModelRequestAt: null,
      firstToolCallAt: null,
      revokedAt: null,
    },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
  const runtime = { calls: 0, starts: 0, destroys: 0, hold: false, release: () => {} };
  const container = {
    running: true,
    destroy: async () => {
      runtime.destroys++;
      container.running = false;
    },
    start: () => {
      runtime.starts++;
      container.running = true;
    },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (port === 8318)
            return Response.json({ boot_id: "fixture-boot", started_at: "2026-01-01T00:00:00Z" });
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (port === 8317 && request.method === "POST" && path === "/v1/responses") {
            runtime.calls++;
            if (!runtime.hold) return Response.json({ ok: true });
            // A stream the test ends, like a long model answer still running.
            const body = new ReadableStream<Uint8Array>({
              start: (controller) => {
                controller.enqueue(new TextEncoder().encode("data: tick\n\n"));
                runtime.release = () => controller.close();
              },
            });
            return new Response(body, { headers: { "content-type": "text/event-stream" } });
          }
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
            if (endpoint === "/capabilities") return Response.json({ capabilities: {} });
            return Response.json({});
          }
          return new Response(null, { status: 404 });
        },
      };
    },
  };
  const aborted: string[] = [];
  const ctx = {
    id: { toString: () => "a".repeat(64) },
    container,
    abort: (reason: string) => {
      aborted.push(reason);
    },
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
    TOOLS_SERVICE: { fetch: async () => new Response(null, { status: 204 }) },
    POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/fixture",
    POOL_MANAGEMENT_KEY: "fixture-management-key",
    POOL_AUTH_DATABASE: { connectionString: "postgres://fixture" },
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_IMAGE_HASH: "fixture-image",
  });
  const drain = async () => {
    for (let i = 0; i < waitUntil.length; i++) await waitUntil[i];
  };
  const modelCall = () =>
    worker.fetch(
      new Request("https://pool.example/v1/responses", {
        method: "POST",
        headers: { Authorization: "Bearer private-model-request-key-73" },
        body: "private-model-request-body",
      }),
    );
  await worker.alarm();
  await drain();
  const served = await modelCall();
  assert.equal(served.status, 200, "the pool serves before the handover");
  // Read through, as the entrypoint does: an answer still being read counts as in flight.
  await served.text();
  await drain();
  assert.equal(runtime.calls, 1);
  // The first warm may restart the fixture's container; only what the handover does is counted.
  const before = { starts: runtime.starts, destroys: runtime.destroys };

  // The adoption read of an entrypoint on this same code changes nothing.
  worker.deploymentIdentity({ candidate: productionOpsRelease, workerInput: poolWorkerRevision });
  worker.deploymentIdentity();
  await drain();
  assert.deepEqual(aborted, []);

  // A deployed entrypoint on other code while a model stream is still running: the stream holds
  // the reset until its answer is read through.
  runtime.hold = true;
  const streaming = await modelCall();
  runtime.hold = false;
  assert.equal(streaming.status, 200);
  worker.deploymentIdentity({ candidate: "f".repeat(40), workerInput: "e".repeat(64) });
  await new Promise((done) => setTimeout(done, 600));
  assert.deepEqual(aborted, [], "an open model stream holds the reset");
  runtime.release();
  assert.match(await streaming.text(), /tick/);
  worker.deploymentIdentity({ candidate: "f".repeat(40), workerInput: "e".repeat(64) });
  await drain();
  assert.deepEqual(aborted, ["code handover"], "one reset for repeated adoption reads");

  // This fixture's reset changes nothing, so the object still refuses as it would until it resets.
  const refused = await modelCall();
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get(codeHandoverHeader), "draining");
  assert.equal(refused.headers.get("Retry-After"), "1");
  assert.equal(runtime.calls, 2, "the refused call never reached the runtime");
  // An app's model call is refused where it enters, before it records its single-use nonce.
  const custody = structuredClone(storage.get("app-model-key-custody-v1"));
  const appCall = await worker.fetch(
    new Request(`https://pool.example${appModelPath}`, { method: "POST", body: "{}" }),
  );
  assert.equal(appCall.status, 503);
  assert.equal(appCall.headers.get(codeHandoverHeader), "draining");
  assert.equal(appCall.headers.get("Retry-After"), "1");
  assert.deepEqual(storage.get("app-model-key-custody-v1"), custody, "no nonce was recorded");
  assert.deepEqual(
    { starts: runtime.starts, destroys: runtime.destroys, running: container.running },
    { ...before, running: true },
    "the handover neither stops nor starts the container",
  );
});
