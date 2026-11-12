import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { runtimeProofFixture } from "../../scripts/release-barrier/test/runtime-proof-fixture.ts";
import {
  RuntimeFleetConfiguration,
  type FleetConfiguration,
} from "./runtime-fleet/configuration.ts";
import { RuntimeProviderReader } from "./runtime-provider/read.ts";
import { providerDigest } from "./runtime-provider/canonical.ts";
import { decodeProviderApplication } from "./runtime-provider/application.ts";
import { runtimeApplicationSettings } from "./runtime-provider/settings.ts";
import { RuntimeHandoff } from "./runtime-slots/integration.ts";
import { handleRuntimeHandoff } from "./runtime-slots/http.ts";
import { runtimeHandoffCommandPrefix } from "./runtime-slots/handoff-command.ts";
import { signEnvelope } from "./token.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

async function fixture() {
  const original = await runtimeProofFixture();
  const raw = ["blue", "green"].map((color) => ({
    ...structuredClone(original.raw),
    id: color,
    durable_objects: { namespace_id: `${color}-namespace` },
    max_instances: 4,
  }));
  let available = true,
    reads = 0;
  const provider = new RuntimeProviderReader("synthetic-read-token", async (input, init) => {
    reads++;
    assert.equal(init.method, "GET");
    if (!available) return new Response(null, { status: 403 });
    const app = raw.find((value) => new URL(input).pathname.includes(`/applications/${value.id}`));
    assert.ok(app);
    return Response.json({
      success: true,
      errors: [],
      result: new URL(input).pathname.endsWith("instances-v2") ? [] : app,
      result_info: { next_page_token: "" },
    });
  });
  const applications = await Promise.all(
    raw.map(async (app, index) => ({
      color: index === 0 ? ("blue" as const) : ("green" as const),
      applicationId: app.id,
      namespaceId: app.durable_objects.namespace_id,
      accountId: app.account_id,
      applicationVersion: "1",
      imageDigest: original.manifest.target.imageDigest,
      imageInput: `${index + 1}`.repeat(16),
      applicationConfigDigest: await providerDigest(
        runtimeApplicationSettings(decodeProviderApplication(app)),
      ),
    })),
  );
  const code = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
  const legacy = {
    ...original.manifest.selection.active!,
    controllerId: "a".repeat(64),
    instanceId: "a".repeat(64),
  };
  const input: FleetConfiguration = {
    format: "pool-runtime-fleet-v1",
    controllerCode: code,
    controllerId: legacy.controllerId,
    legacy,
    revision: 1,
    previousDigest: null,
    active: "blue",
    applications,
    maximum: 4,
    targetActive: 25,
    idleMilliseconds: 60_000,
  };
  const storage = new SlotMemory(),
    state = new RuntimeFleetState(storage, 4);
  const deps = {
    storage,
    controllerId: legacy.controllerId,
    code,
    bindings: () => applications,
    legacy: async () => legacy,
    occupied: (transaction?: Parameters<typeof state.inspect>[0]) => state.inspect(transaction),
    provider,
  };
  return {
    raw,
    input,
    storage,
    state,
    code,
    deps,
    service: new RuntimeFleetConfiguration(deps),
    available: (value: boolean) => {
      available = value;
    },
    reads: () => reads,
  };
}

test("signed fleet permission names both exact bound applications and has no launch side effect", async () => {
  const f = await fixture();
  const handoff = new RuntimeHandoff(
    {
      id: { toString: () => f.input.controllerId },
      storage: {
        ...f.storage,
        get: f.storage.get.bind(f.storage),
        put: f.storage.put.bind(f.storage),
        transaction: f.storage.transaction.bind(f.storage),
        getAlarm: async () => null,
        setAlarm: async () => {},
      },
      waitUntil: () => {},
    },
    {
      POOL_DATABASE_URL: "postgres://synthetic.invalid/pool",
      POOL_MANAGEMENT_KEY: "synthetic",
      POOL_APP_SIGNING_KEY: "a".repeat(64),
      POOL_IMAGE_HASH: "a".repeat(16),
      POOL_DEPLOYMENT_KEY: "e".repeat(64),
    },
    f.code,
    { wrap: (response) => response },
  );
  const at = Date.now();
  const command = {
    action: "fleet-configure",
    controllerCode: f.code,
    operationId: "activation-1",
    configuration: f.input,
    at,
    expiresAt: at + 60_000,
  };
  const send = async (key: string) =>
    handleRuntimeHandoff(
      new Request("http://private/runtime-handoff", {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(key, runtimeHandoffCommandPrefix, command),
        }),
      }),
      handoff,
      f.code,
      "e".repeat(64),
      f.service,
    );
  assert.equal((await send("f".repeat(64))).status, 409);
  assert.equal(await f.service.inspect(), undefined);
  assert.equal((await send("e".repeat(64))).status, 200);
  assert.equal(f.reads(), 2);
  assert.deepEqual(await f.state.inspect(), []);
});

test("unknown activation acknowledgement is inspection-only and cannot change the same operation", async () => {
  const f = await fixture();
  f.storage.afterCommit = () => {
    throw new Error("synthetic lost ACK");
  };
  await assert.rejects(f.service.configure("activation-1", f.input), /lost ACK/);
  f.storage.afterCommit = () => {};
  const restored = new RuntimeFleetConfiguration(f.deps);
  const reads = f.reads();
  assert.deepEqual(
    await restored.configure("activation-1", f.input),
    await restored.inspect("activation-1"),
  );
  assert.equal(f.reads(), reads);
  await assert.rejects(
    restored.configure("activation-1", { ...f.input, targetActive: 26 }),
    /identity/,
  );
  assert.deepEqual(await f.state.inspect(), []);
});

test("provider refusal, another binding, stale code and a fifth resource never authorize activation", async () => {
  const f = await fixture();
  f.available(false);
  await assert.rejects(
    f.service.configure("provider-unavailable", f.input),
    /provider observation refused/,
  );
  assert.equal(await f.service.inspect(), undefined);
  f.available(true);
  for (const changed of [
    { ...f.input, maximum: 5 },
    { ...f.input, controllerCode: { ...f.code, candidate: "f".repeat(40) } },
    {
      ...f.input,
      applications: [
        f.input.applications[0]!,
        { ...f.input.applications[1]!, applicationId: "other" },
      ],
    },
  ])
    await assert.rejects(f.service.configure("invalid", changed));
  assert.equal(await f.service.inspect(), undefined);
});

test("configuration uses a revision CAS and cannot change the image of an occupied application", async () => {
  const f = await fixture();
  const first = await f.service.configure("first", f.input);
  const app = f.input.applications[0]!;
  await f.state.reserve({
    ...f.input.legacy,
    slotId: "occupied",
    applicationId: app.applicationId,
    applicationVersion: app.applicationVersion,
    imageDigest: app.imageDigest,
    imageInput: app.imageInput,
    instanceId: "b".repeat(64),
    homePeerOrdinal: 1,
  });
  const second = {
    ...f.input,
    revision: 2,
    previousDigest: first.digest,
    active: "green" as const,
  };
  await f.service.configure("second", second);
  await assert.rejects(f.service.configure("stale", second), /selection/);
  const changed = {
    ...second,
    revision: 3,
    previousDigest: (await f.service.inspect())!.digest,
    applications: second.applications.map((value) =>
      value.color === "blue" ? { ...value, applicationVersion: "2" } : value,
    ),
  };
  await assert.rejects(f.service.configure("live-image-change", changed), /uncertain/);
  assert.equal((await f.service.inspect())!.operationId, "second");
});

test("disable survives a lost acknowledgement and re-enabling requires a new signed revision", async () => {
  const f = await fixture();
  const first = await f.service.configure("first", f.input);
  f.storage.afterCommit = () => {
    throw new Error("synthetic lost ACK");
  };
  await assert.rejects(f.service.disable("stop", first.digest), /lost ACK/);
  f.storage.afterCommit = () => {};
  const restored = new RuntimeFleetConfiguration(f.deps);
  assert.equal((await restored.inspect())!.enabled, false);
  assert.deepEqual(await restored.disable("stop", first.digest), await restored.inspect("stop"));
  await assert.rejects(restored.configure("old-revision", f.input), /selection/);
  await restored.configure("restart", { ...f.input, revision: 2, previousDigest: first.digest });
  assert.equal((await restored.inspect())!.enabled, true);
});
