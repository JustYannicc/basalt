import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { runtimeProofFixture } from "../../scripts/release-barrier/test/runtime-proof-fixture.ts";
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
  const provider = new RuntimeProviderReader("synthetic-provider-token", async (input) => {
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
  const transport = { stubs: 0, calls: 0, fail: false };
  const cell = boundFleetCell({
    ctx: root,
    env,
    target,
    code: runtimeFixtureCode,
    provider,
    application: { ...application, color: "blue", imageInput: target.imageInput },
    wrap: runtime.wrap,
    remote: () => {
      transport.stubs++;
      return {
        fetch: async (request) => {
          transport.calls++;
          if (transport.fail) throw new Error("native transport failed");
          return runtime.stub.fetch(request);
        },
      };
    },
  });
  return {
    ...runtime,
    cell,
    transport,
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
  await f.cell.retire(selected);
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
