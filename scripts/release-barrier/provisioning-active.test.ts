import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { handoffWorker } from "../pool-tests/runtime-handoff-worker.ts";
import { runtimeFixtureCode } from "../pool-tests/runtime-handoff-proofs.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";
import { provisioningFixture } from "./test/provisioning-fixtures.ts";
import { readProvisioningActive } from "./provisioning-active.ts";
import { runtimeBridgeKeyDigest } from "./runtime-slot-manifest.ts";
import { runtimeApplicationConfigDigest } from "./runtime-slot-provider-proof.ts";
import { decodeApplication } from "./container-observation.ts";
import type { Fetcher } from "../deploy-safety/http.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";

async function fixture(adopt = true) {
  const f = await handoffWorker({ adopt });
  const original = await runtimeProofFixture();
  const raw = {
    ...original.raw,
    id: f.old.target.applicationId,
    version: Number(f.old.target.applicationVersion),
    durable_objects: { namespace_id: "legacy-namespace" },
    configuration: {
      ...original.raw.configuration,
      image: `registry.cloudflare.com/${original.raw.account_id}/synthetic@${f.old.target.imageDigest}`,
    },
  };
  const base = provisioningFixture().manifest;
  const manifest = {
    ...base,
    active: {
      ...base.active,
      applicationId: raw.id,
      version: raw.version,
      configurationDigest: runtimeApplicationConfigDigest(decodeApplication(raw)),
      bootId: f.old.identity().bootId,
      selectionEpoch: 1,
    },
  };
  const read = {
    controllerCode: runtimeFixtureCode,
    controller: { accountId: raw.account_id, scriptName: "synthetic-controller" },
    bridgeKeyDigest: runtimeBridgeKeyDigest(f.old.env.POOL_DEPLOYMENT_KEY!),
    target: f.old.target,
  };
  const calls: string[] = [];
  let applicationReads = 0,
    drift = false;
  const fetcher: Fetcher = async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.cloudflare.com");
    calls.push(url.pathname);
    const instances = url.pathname.endsWith("/instances-v2");
    if (!instances) applicationReads++;
    return Response.json({
      success: true,
      errors: [],
      result: instances
        ? [
            {
              id: f.old.target.instanceId,
              application_id: raw.id,
              status: { state: "running" },
              image: raw.configuration.image,
            },
          ]
        : { ...raw, version: drift && applicationReads > 2 ? raw.version + 1 : raw.version },
      result_info: { next_page_token: "" },
    });
  };
  const bridge = { opened: 0, closed: 0 };
  const connect: PoolOperationsTarget["connect"] = async () => {
    bridge.opened++;
    return {
      env: { POOL_OPERATIONS: { fetch: (request) => f.worker.runtimeHandoff(request) } },
      dispose: async () => {
        bridge.closed++;
      },
    };
  };
  const run = () =>
    Effect.runPromise(
      readProvisioningActive(manifest, read, f.old.env.POOL_DEPLOYMENT_KEY!, {
        fetcher,
        connect,
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic-provider-read" } }),
          ),
        ),
      ),
    );
  return {
    f,
    manifest,
    read,
    calls,
    bridge,
    run,
    drift: () => {
      drift = true;
    },
  };
}

test("provisioning joins passive actual-controller legacy boot/selection to fresh provider reads without writes or keepalive", async (context) => {
  const h = await fixture();
  context.after(h.f.cleanup);
  const keepAlive = h.f.old.calls.keepAlive;
  let writes = 0;
  h.f.old.storage.afterCommit = (keys) => {
    writes += keys.length;
  };
  assert.deepEqual(await h.run(), h.manifest.active);
  assert.equal(writes, 0);
  assert.equal(h.f.old.calls.keepAlive, keepAlive);
  assert.equal(h.f.old.calls.start, 0);
  assert.equal(h.f.old.calls.destroy, 0);
  assert.equal(h.calls.filter((path) => path.endsWith("/instances-v2")).length, 1);
  assert.deepEqual(h.bridge, { opened: 1, closed: 1 });
});

for (const kind of ["unadopted", "boot", "epoch", "provider", "signer"] as const)
  test(`provisioning refuses ${kind} drift rather than starting or repairing the legacy runtime`, async (context) => {
    const h = await fixture(kind !== "unadopted");
    context.after(h.f.cleanup);
    if (kind === "boot") h.f.old.replaceBoot();
    if (kind === "epoch") h.manifest.active.selectionEpoch++;
    if (kind === "provider") h.drift();
    if (kind === "signer") h.read.bridgeKeyDigest = "f".repeat(64);
    await assert.rejects(h.run());
    assert.equal(h.f.old.calls.start, 0);
    assert.equal(h.f.old.calls.destroy, 0);
    assert.equal(h.bridge.opened, h.bridge.closed);
    if (kind === "signer") assert.deepEqual(h.calls, []);
  });
