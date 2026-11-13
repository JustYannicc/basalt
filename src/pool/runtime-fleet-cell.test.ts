import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { runtimeProofFixture } from "../../scripts/release-barrier/test/runtime-proof-fixture.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { boundFleetCell } from "./runtime-fleet/bound-cell.ts";
import { RuntimeProviderReader } from "./runtime-provider/read.ts";
import { decodeProviderApplication } from "./runtime-provider/application.ts";
import { providerDigest } from "./runtime-provider/canonical.ts";
import { runtimeApplicationSettings } from "./runtime-provider/settings.ts";

async function fixture() {
  const providerFixture = await runtimeProofFixture();
  const target = { ...providerFixture.manifest.target, homePeerOrdinal: 1 };
  const env = {
    POOL_RUNTIME_APPLICATION_ID: target.applicationId,
    POOL_CONTAINER_APPLICATION_ID: "legacy",
    POOL_DATABASE_URL: "postgresql://synthetic@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "synthetic-management",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_DEPLOYMENT_KEY: "b".repeat(64),
    POOL_IMAGE_HASH: target.imageInput,
  };
  const runtime = await handoffRuntime(target, env);
  const storage = new RuntimeSqlite(),
    background: Promise<unknown>[] = [];
  const root = {
    id: { toString: () => target.controllerId },
    storage,
    waitUntil: (work: Promise<unknown>) => {
      background.push(work);
    },
  };
  let failApplication = false,
    failRuntime = false;
  let credential: string | null = "synthetic-provider-token";
  const provider = new RuntimeProviderReader({ get: async () => credential }, async (input) => {
    const instances = new URL(input).pathname.endsWith("instances-v2");
    if (instances ? failRuntime : failApplication) return new Response(null, { status: 403 });
    return Response.json({
      success: true,
      errors: [],
      result: instances
        ? runtime.ctx.container.running
          ? [
              {
                id: target.instanceId,
                application_id: target.applicationId,
                image: providerFixture.raw.configuration.image,
                status: { state: "running" },
              },
            ]
          : []
        : providerFixture.raw,
      result_info: { next_page_token: "" },
    });
  });
  const application = {
    ...providerFixture.manifest.provider,
    applicationId: target.applicationId,
    applicationVersion: target.applicationVersion,
    imageDigest: target.imageDigest,
    applicationConfigDigest: await providerDigest(
      runtimeApplicationSettings(decodeProviderApplication(providerFixture.raw)),
    ),
  };
  const modelStubs: number[] = [];
  const transport = {
    stubs: 0,
    calls: 0,
    fail: false,
    generation: 0,
    disconnected: 0,
    failHealth: false,
    modelStubs,
  };
  const cell = boundFleetCell({
    ctx: root,
    env,
    target,
    code: runtimeFixtureCode,
    provider,
    application: { ...application, color: "blue", imageInput: target.imageInput },
    wrap: runtime.wrap,
    remote: () => {
      const stub = ++transport.stubs;
      const generation = transport.generation;
      return {
        fetch: async (request) => {
          transport.calls++;
          if (transport.fail) throw new Error("native transport failed");
          if (
            generation !== transport.generation ||
            (transport.failHealth && new URL(request.url).pathname === "/health")
          ) {
            transport.disconnected++;
            await request.text();
            throw Object.assign(new Error("synthetic stale endpoint stub"), {
              disconnected: true,
              retryable: true,
            });
          }
          if (request.headers.has("X-Signalbox-Runtime-Identity")) transport.modelStubs.push(stub);
          return runtime.stub.fetch(request);
        },
      };
    },
  });
  return {
    ...runtime,
    cell,
    storage,
    transport,
    secret: (value: string | null) => {
      credential = value;
    },
    failApplication: (value: boolean) => {
      failApplication = value;
    },
    failRuntime: (value: boolean) => {
      failRuntime = value;
    },
    cleanup: async () => {
      await Promise.all(background);
      await storage.close();
      await runtime.cleanup();
    },
  };
}

test("a fleet cell joins provider reads to the retained actual start witness before it can forward", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const selected = await f.cell.start(f.target);
  assert.equal(selected.bootId, f.identity().bootId);
  assert.equal(f.calls.start, 1);
  let dispatched = 0;
  const response = await f.cell.forward(
    new Request("http://pool/v1/responses"),
    8317,
    undefined,
    () => {
      dispatched++;
    },
  );
  await response.text();
  assert.equal(dispatched, 1);
  assert.equal(f.calls.model, 1);
  assert.deepEqual(await f.cell.drain(selected), { active: 0, known: true });
  await f.cell.retire(selected, async () => {});
  assert.equal(await f.cell.retired(selected), true);
  assert.equal(f.calls.destroy, 1);
  assert.equal(f.transport.stubs, 1);
});

test("an unavailable provider read cannot launch compute", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  f.failApplication(true);
  await assert.rejects(f.cell.start(f.target), /provider observation refused/);
  assert.equal(f.calls.start, 0);
  assert.equal(await f.cell.selected(), undefined);
});

test("a lost provider join after startup is recovered through observation without another start", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  f.failRuntime(true);
  await assert.rejects(f.cell.start(f.target), /provider observation refused/);
  assert.equal(f.calls.start, 1);
  assert.equal(await f.cell.selected(), undefined);
  f.failRuntime(false);
  assert.equal((await f.cell.observe(f.target))?.bootId, f.identity().bootId);
  assert.equal(f.calls.start, 1);
});

test("a native stub failure is never replayed, and the next call reconnects", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  await f.cell.start(f.target);
  const before = f.transport.calls;
  f.transport.fail = true;
  await assert.rejects(
    f.cell.forward(new Request("http://pool/v1/responses"), 8317, undefined, () => {}),
    /native transport failed/,
  );
  assert.equal(f.transport.calls, before + 1);
  assert.equal(f.transport.stubs, 1);
  assert.equal(f.calls.model, 0);
  f.transport.fail = false;
  const response = await f.cell.forward(
    new Request("http://pool/v1/responses"),
    8317,
    undefined,
    () => {},
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(f.transport.stubs, 2);
  assert.equal(f.calls.model, 1);
});

test("a missing observation secret cannot launch and the same cell activates when it appears", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  f.secret(null);
  await assert.rejects(f.cell.start(f.target), /provider observation refused/);
  assert.equal(f.calls.start, 0);
  assert.equal(await f.cell.selected(), undefined);
  f.secret("synthetic-provider-token");
  assert.equal(await f.cell.observe(f.target), undefined);
  assert.equal(f.calls.start, 0);
  assert.equal((await f.cell.observe(f.target, true))?.bootId, f.identity().bootId);
  assert.equal(f.calls.start, 1);
});

test("an absent observation secret holds draining capacity without destruction and later enables retirement", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const selected = await f.cell.start(f.target);
  const state = new RuntimeFleetState(f.storage, 4);
  await state.reserve(f.target);
  await state.dispatch(f.target);
  await state.ready(selected);
  await state.drain(selected);
  const fleet = new RuntimeFleet({
    state,
    target: async () => f.target,
    cell: () => f.cell,
    legacyActive: async () => 0,
    currentRequests: () => 0,
    targetActive: 1,
    idleMilliseconds: 1000,
    maximum: 4,
    defer: () => {},
    wrap: f.wrap,
    now: Date.now,
  });
  f.secret(null);
  await assert.rejects(fleet.upkeep(), /provider observation refused/);
  assert.equal(f.calls.destroy, 0);
  assert.equal((await state.inspect()).length, 1);
  assert.equal((await state.inspect())[0]?.phase, "draining");
  f.secret("synthetic-provider-token");
  await fleet.upkeep();
  assert.equal(f.calls.destroy, 1);
  assert.deepEqual(await state.inspect(), []);
  assert.equal(f.calls.start, 1);
});

test("a disconnected cached stub reconnects health before the first model send", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const selected = await f.cell.start(f.target);
  assert.equal(f.transport.stubs, 1);
  f.transport.generation++;
  const direct = await f.stub.fetch(
    new Request("http://runtime/observe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: f.target }),
    }),
  );
  assert.equal(direct.status, 200);
  const observed = await direct.json();
  assert.equal(observed.identity.bootId, selected.bootId);
  let dispatched = 0;
  const response = await f.cell.forward(
    new Request("http://pool/v1/responses"),
    8317,
    undefined,
    () => {
      dispatched++;
    },
  );
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(f.transport.disconnected, 1);
  assert.equal(f.transport.stubs, 2);
  assert.deepEqual(f.transport.modelStubs, [2]);
  assert.deepEqual(await f.cell.drain(selected), { active: 0, known: true });
  assert.equal(f.transport.stubs, 2);
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.model, 1);
  assert.equal(dispatched, 1);
});

test("a disconnected health probe reconnects at most once before refusing dispatch", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  await f.cell.start(f.target);
  f.transport.generation++;
  f.transport.failHealth = true;
  const before = f.transport.calls;
  let dispatched = 0;
  await assert.rejects(
    f.cell.forward(new Request("http://pool/v1/responses"), 8317, undefined, () => {
      dispatched++;
    }),
    /synthetic stale endpoint stub/,
  );
  assert.equal(f.transport.calls, before + 2);
  assert.equal(f.transport.stubs, 2);
  assert.equal(f.transport.disconnected, 2);
  assert.equal(f.calls.model, 0);
  assert.equal(dispatched, 0);
});

test("a disconnected error after model dispatch never resends the model request", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  await f.cell.start(f.target);
  f.hooks.model = async () => {
    throw Object.assign(new Error("synthetic failure after model dispatch"), {
      disconnected: true,
      retryable: true,
    });
  };
  let dispatched = 0;
  await assert.rejects(
    f.cell.forward(new Request("http://pool/v1/responses"), 8317, undefined, () => {
      dispatched++;
    }),
  );
  assert.equal(f.transport.stubs, 1);
  assert.equal(f.calls.model, 1);
  assert.equal(dispatched, 1);
});
