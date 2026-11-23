import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { runtimeProofFixture } from "../../scripts/pool-fleet/test/runtime-proof-fixture.ts";
import type { FleetConfiguration } from "./runtime-fleet/configuration.ts";
import { PoolRuntimeFleet } from "./runtime-fleet/production.ts";
import { decodeProviderApplication } from "./runtime-provider/application.ts";
import { providerDigest } from "./runtime-provider/canonical.ts";
import { RuntimeProviderReader } from "./runtime-provider/read.ts";
import { runtimeApplicationSettings } from "./runtime-provider/settings.ts";
import type { ControllerCode, SlotTarget } from "./runtime-slots/contract.ts";
import { RuntimeHandoff } from "./runtime-slots/integration.ts";
import { slotSelectionKey } from "./runtime-slots/storage.ts";

// #1802: a Worker deploy changes the controller code. A permission the signed command committed
// under the last code must stay in force under the next one; only the commit checks the code.
const before: ControllerCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
const after: ControllerCode = { candidate: "e".repeat(40), workerInput: "f".repeat(64) };

async function fixture() {
  const original = await runtimeProofFixture();
  const raw = ["blue", "green"].map((color) => ({
    ...structuredClone(original.raw),
    id: color,
    durable_objects: { namespace_id: `${color}-namespace` },
    max_instances: 4,
  }));
  const provider = new RuntimeProviderReader("synthetic-read-token", async (input) => {
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
  const controllerId = "a".repeat(64);
  const legacy = {
    ...original.manifest.selection.active!,
    controllerId,
    instanceId: controllerId,
  };
  const { bootId: _bootId, ...legacyTarget } = legacy;
  const storage = new SlotMemory();
  await storage.put(slotSelectionKey, {
    epoch: 1,
    active: { target: legacyTarget, identity: legacy, fenced: false },
  });
  const ctx = {
    id: { toString: () => controllerId },
    storage: Object.assign(storage, { getAlarm: async () => null, setAlarm: async () => {} }),
    waitUntil: () => {},
  };
  const env = {
    POOL_DATABASE_URL: "postgres://synthetic.invalid/pool",
    POOL_MANAGEMENT_KEY: "synthetic",
    POOL_APP_SIGNING_KEY: "a".repeat(64),
    POOL_IMAGE_HASH: legacy.imageInput,
    POOL_DEPLOYMENT_KEY: "e".repeat(64),
    POOL_CONTAINER_APPLICATION_ID: legacy.applicationId,
  };
  let bound = applications;
  // One Worker version: its own code and its own bound applications, over the one storage.
  const worker = (code: ControllerCode) =>
    new PoolRuntimeFleet({
      ctx: ctx as never,
      env,
      code,
      handoff: new RuntimeHandoff(ctx as never, env, code, { wrap: (response) => response }),
      namespaces: () =>
        bound.map(({ color, applicationId, imageInput }) => ({
          color,
          applicationId,
          imageInput,
          instanceId: (name: string) => `${color}-${name}`,
          endpoint: () => {
            throw new Error("No cell is started in this test");
          },
        })),
      provider,
      legacyPeers: {} as never,
      currentRequests: () => 0,
      wrap: (response) => response,
    });
  const configuration: FleetConfiguration = {
    format: "pool-runtime-fleet-v1",
    controllerCode: before,
    controllerId,
    legacy,
    revision: 1,
    previousDigest: null,
    active: "blue",
    applications,
    maximum: 4,
    targetActive: 25,
    idleMilliseconds: 60_000,
  };
  let slot = 0;
  const launch = (): SlotTarget => ({
    format: "pool-runtime-slot-v1",
    controllerId,
    slotId: `cell-${++slot}`,
    instanceId: `blue-runtime-${slot}`,
    applicationId: applications[0]!.applicationId,
    applicationVersion: applications[0]!.applicationVersion,
    imageDigest: applications[0]!.imageDigest,
    imageInput: applications[0]!.imageInput,
    homePeerOrdinal: slot,
  });
  return {
    worker,
    configuration,
    applications,
    legacy,
    storage,
    launch,
    rebind: (next: typeof applications) => {
      bound = next;
    },
  };
}

test("a permission committed under the last code launches and inspects in force under the next", async () => {
  const f = await fixture();
  await f.worker(before).configure("enable", f.configuration);
  const deployed = f.worker(after);
  await deployed.state.reserve(f.launch());
  assert.equal((await deployed.state.inspect()).length, 1, "the launch reserved its row");
  const view = await deployed.inspect();
  assert.equal(view.inForce, true);
  assert.equal(view.notInForce, undefined);
});

test("a primary promotion under the next code keeps the permission", async () => {
  const f = await fixture();
  await f.worker(before).configure("enable", f.configuration);
  const deployed = f.worker(after);
  const green = f.applications[1]!;
  const candidate = {
    ...f.legacy,
    slotId: "promoted",
    applicationId: green.applicationId,
    applicationVersion: green.applicationVersion,
    imageDigest: green.imageDigest,
    imageInput: green.imageInput,
    instanceId: "b".repeat(64),
  };
  await f.storage.transaction((transaction) =>
    deployed.configuration.promotePrimary(
      {
        operationId: "promote",
        controllerCode: after,
        expectedEpoch: 1,
        policyDigest: "6".repeat(64),
        previous: f.legacy,
        candidate,
      },
      transaction,
    ),
  );
  const record = await deployed.configuration.inspect();
  assert.equal(record?.configuration.revision, 2);
  assert.equal(record?.configuration.active, "green");
  assert.equal((await deployed.inspect()).inForce, true);
});

test("a configure under the next code still refuses a configuration signed for the last", async () => {
  const f = await fixture();
  const first = await f.worker(before).configure("enable", f.configuration);
  const next = { ...f.configuration, revision: 2, previousDigest: first.digest };
  await assert.rejects(f.worker(after).configure("again", next), /identity/);
  const committed = await f.worker(after).configure("again-signed", {
    ...next,
    controllerCode: after,
  });
  assert.equal(committed.configuration.revision, 2);
});

test("inspect says why a stored permission is not in force, and launches agree", async () => {
  const f = await fixture();
  const first = await f.worker(before).configure("enable", f.configuration);
  // An image release changes the Worker's bound image input; the stored permission names the old.
  f.rebind(
    f.applications.map((app) =>
      app.color === "blue" ? { ...app, imageInput: "9".repeat(16) } : app,
    ),
  );
  const imaged = f.worker(after);
  assert.deepEqual(
    { inForce: (await imaged.inspect()).inForce, notInForce: (await imaged.inspect()).notInForce },
    { inForce: false, notInForce: "bindings" },
  );
  await assert.rejects(imaged.state.reserve(f.launch()), /identity/);
  f.rebind(f.applications);
  const deployed = f.worker(after);
  await deployed.disable("stop", first.digest);
  const view = await deployed.inspect();
  assert.deepEqual(
    { inForce: view.inForce, notInForce: view.notInForce },
    { inForce: false, notInForce: "disabled" },
  );
  await assert.rejects(deployed.state.reserve(f.launch()), /selection/);
});
