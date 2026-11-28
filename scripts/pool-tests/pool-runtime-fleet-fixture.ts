import assert from "node:assert/strict";
import { SlotMemory } from "./runtime-slot-storage.ts";
import { runtimeProofFixture } from "../pool-fleet/test/runtime-proof-fixture.ts";
import { runningInstance } from "../pool-fleet/test/cloudflare-shapes.ts";
import type { FleetConfiguration } from "../../src/pool/runtime-fleet/configuration.ts";
import { PoolRuntimeFleet } from "../../src/pool/runtime-fleet/production.ts";
import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import { providerDigest } from "../../src/pool/runtime-provider/canonical.ts";
import { RuntimeProviderReader } from "../../src/pool/runtime-provider/read.ts";
import { runtimeApplicationSettings } from "../../src/pool/runtime-provider/settings.ts";
import type { ControllerCode, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import { RuntimeHandoff } from "../../src/pool/runtime-slots/integration.ts";
import { slotSelectionKey } from "../../src/pool/runtime-slots/storage.ts";

/**
 * The production fleet over one storage, its blue and green applications read from recorded
 * shapes. No cell endpoint is ever reached. `listed` is the provider's instance listing, by
 * instance id and state, for both applications; it starts empty.
 */
export async function poolRuntimeFleetFixture(configured: ControllerCode) {
  const original = await runtimeProofFixture();
  const raw = ["blue", "green"].map((color) => ({
    ...structuredClone(original.raw),
    id: color,
    durable_objects: { namespace_id: `${color}-namespace` },
    max_instances: 4,
  }));
  const listed = new Map<string, string>();
  const provider = new RuntimeProviderReader("synthetic-read-token", async (input) => {
    const app = raw.find((value) => new URL(input).pathname.includes(`/applications/${value.id}`));
    assert.ok(app);
    const instances = [...listed].map(([id, state]) => {
      const shape = runningInstance(id, app.configuration.image, app.id);
      return { ...shape, status: { ...shape.status, state } };
    });
    return Response.json({
      success: true,
      errors: [],
      result: new URL(input).pathname.endsWith("instances-v2") ? instances : app,
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
            throw new Error("No cell endpoint is reached in these tests");
          },
        })),
      provider,
      legacyPeers: {} as never,
      currentRequests: () => 0,
      wrap: (response) => response,
    });
  const configuration: FleetConfiguration = {
    format: "pool-runtime-fleet-v1",
    controllerCode: configured,
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
    listed,
    rebind: (next: typeof applications) => {
      bound = next;
    },
  };
}
