import assert from "node:assert/strict";
import { test } from "node:test";
import { provisionRuntime, type RuntimeProvisioningProvider } from "./runtime-provisioning.ts";
import { decodeCreatedRuntime } from "./provisioning-apply.ts";
import { provisioningFixture } from "./test/provisioning-fixtures.ts";
import { decodeNamespaceBaseline } from "./provisioning-namespace.ts";
import { readRuntimeExports } from "./provisioning-exports.ts";
import { decodeRuntimeCreate, type RuntimeResourceName } from "./runtime-create-schema.ts";
import type { ProvisioningRecord, ProvisioningStore } from "./provisioning-journal.ts";

function harness(name: RuntimeResourceName = "PoolRuntime") {
  const f = provisioningFixture(name);
  const counts = { baseline: 0, stage: 0, activate: 0, create: 0, reads: 0 };
  let activated = false;
  let current = f.baseline.version.id;
  let record: ProvisioningRecord | undefined;
  let lostCreate = false;
  const { accountId: _account, workerId: _worker, deploy: _deploy, ...settings } = f.request;
  const staged = decodeNamespaceBaseline({
    ...f.baseline,
    version: {
      ...f.baseline.version,
      ...settings,
      id: "staged-version",
      number: 2,
      bindings: [
        ...f.baseline.version.bindings!,
        {
          name,
          type: "durable_object_namespace",
          className: name,
          namespaceId: f.namespaceId,
        },
      ],
    },
  }).version;
  const application = decodeCreatedRuntime({
    applicationId: "new-application",
    applicationName: f.manifest.declaration.props.name,
    accountId: f.manifest.declaration.accountId,
    version: 1,
    createdAt: "2026-11-09T00:00:00Z",
    instances: 0,
    maxInstances: f.manifest.declaration.props.maxInstances,
    schedulingPolicy: "default",
    constraints: f.manifest.declaration.props.constraints,
    configuration: {
      image: f.manifest.declaration.props.image,
      instanceType: "basic",
      environmentVariables: [
        { name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: f.manifest.declaration.accountId },
      ],
      observability: f.manifest.declaration.props.observability,
    },
    durableObjects: { namespaceId: f.namespaceId },
  });
  const provider: RuntimeProvisioningProvider = {
    active: async () => {
      counts.reads++;
      return f.manifest.active;
    },
    namespaceBaseline: async () => {
      counts.baseline++;
      return f.baseline;
    },
    stageNamespace: async () => {
      counts.stage++;
      return { versionId: staged.id };
    },
    readNamespaceVersion: async () => staged,
    activateNamespace: async () => {
      counts.activate++;
      activated = true;
      current = staged.id;
      return { deploymentId: "deployment" };
    },
    observeNamespace: async () => ({
      accountId: f.baseline.accountId,
      scriptName: f.baseline.scriptName,
      versionId: current,
      deploymentId: activated ? "deployment" : "prior-deployment",
      namespaces: activated
        ? [
            ...f.baseline.namespaces,
            {
              id: f.namespaceId,
              className: name,
              binding: name,
              storage: "sqlite",
            },
          ]
        : f.baseline.namespaces,
      exports: readRuntimeExports((activated ? staged : f.baseline.version).exports),
      containers: (activated ? staged : f.baseline.version).containers ?? [],
    }),
    applicationAbsent: async () => true,
    createApplication: async () => {
      counts.create++;
      if (lostCreate) throw new Error("Lost reply after commit");
      return application;
    },
    readApplication: async () => application,
    nativeState: async () => ({ application, digest: "1".repeat(64) }),
  };
  const store: ProvisioningStore = {
    exclusive: (work) => work(),
    read: async () => record,
    write: async (value) => {
      record = structuredClone(value);
    },
  };
  const run = (enable = f.enable) =>
    provisionRuntime(f.manifest, store, provider, enable, () => 100);
  return {
    ...f,
    provider,
    store,
    counts,
    run,
    application,
    changeWorker: () => {
      current = "unexpected-version";
    },
    loseCreate: () => {
      lostCreate = true;
    },
    record: () => record,
  };
}

test("provisioning is inert without a separate enable and does no provider reads or writes", async () => {
  const h = harness();
  await assert.rejects(
    provisionRuntime(h.manifest, h.store, h.provider, undefined, () => 100),
    /runtime-provisioning-not-enabled/,
  );
  assert.deepEqual(h.counts, { baseline: 0, stage: 0, activate: 0, create: 0, reads: 0 });
});

test("namespace-first provisioning retains its baseline and never repeats acknowledged operations on resume", async () => {
  const h = harness();
  const receipt = await h.run();
  assert.equal(receipt.disposition, "idle");
  assert.equal(receipt.applicationId, "new-application");
  assert.deepEqual(await h.run(), receipt);
  assert.deepEqual(
    {
      baseline: h.counts.baseline,
      stage: h.counts.stage,
      activate: h.counts.activate,
      create: h.counts.create,
    },
    { baseline: 1, stage: 1, activate: 1, create: 1 },
  );
});

test("lost application reply remains unknown even after restart sees absence", async () => {
  const h = harness();
  h.loseCreate();
  await assert.rejects(h.run(), /provisioning-operation-unknown/);
  await assert.rejects(h.run(), /provisioning-operation-unknown/);
  assert.equal(h.counts.create, 1);
  assert.equal(h.record()!.operations["application-create"]!.outcome, "unknown");
});

test("Worker version drift before activation refuses without activation or application create", async () => {
  const h = harness();
  const stage = h.provider.stageNamespace;
  h.provider.stageNamespace = async (request) => {
    const result = await stage(request);
    h.changeWorker();
    return result;
  };
  await assert.rejects(h.run(), /provisioning-input-drift/);
  assert.equal(h.counts.activate, 0);
  assert.equal(h.counts.create, 0);
});

test("active boot drift refuses before the next mutation", async () => {
  const h = harness();
  const stage = h.provider.stageNamespace;
  h.provider.stageNamespace = async (request) => {
    const result = await stage(request);
    h.provider.active = async () => ({ ...h.manifest.active, bootId: "unexpected-boot" });
    return result;
  };
  await assert.rejects(h.run(), /provisioning-input-drift/);
  assert.equal(h.counts.activate, 0);
  assert.equal(h.counts.create, 0);
});

test("provider configuration readback cannot drop settings or introduce a secret", async () => {
  const h = harness();
  h.provider.readApplication = async () => ({
    ...h.application,
    configuration: {
      ...h.application.configuration,
      environmentVariables: [{ name: "UNREVIEWED_SECRET", value: "synthetic-private" }],
    },
  });
  await assert.rejects(h.run(), /provisioning-input-drift/);
  assert.equal(h.counts.create, 1);
});

for (const name of ["PoolRuntimeBlue", "PoolRuntimeGreen"] as const) {
  test(`${name} provisions only its observed namespace, an idle four-instance application and its own journal`, async () => {
    const h = harness(name);
    const receipt = await h.run();
    assert.equal(receipt.resource, name);
    assert.equal(h.application.instances, 0);
    assert.equal(h.application.maxInstances, 4);
    assert.equal(h.record()!.resource, name);
    assert.deepEqual(await h.run(), receipt);
    assert.equal(h.counts.create, 1);
    assert.equal(h.counts.activate, 1);
  });
}

test("runtime declarations reject crossed identities, an expanded cap and a nonzero initial allocation", () => {
  const declaration = harness("PoolRuntimeBlue").manifest.declaration;
  for (const changed of [
    { ...declaration, fqn: "PoolRuntimeGreen" },
    { ...declaration, namespace: { ...declaration.namespace, binding: "PoolRuntimeGreen" } },
    { ...declaration, props: { ...declaration.props, className: "PoolRuntimeGreen" } },
    { ...declaration, props: { ...declaration.props, maxInstances: 5 } },
    { ...declaration, props: { ...declaration.props, instances: 1 } },
  ])
    assert.throws(() => decodeRuntimeCreate(changed), /runtime-private-input-invalid/);
});

test("a provider's lower or higher application cap does not acknowledge the reviewed declaration", async () => {
  const h = harness("PoolRuntimeBlue");
  const application = { ...h.application, maxInstances: 1 as const };
  h.provider.createApplication = async () => application;
  h.provider.nativeState = async () => ({ application, digest: "1".repeat(64) });
  h.provider.readApplication = async () => application;
  await assert.rejects(h.run(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /provisioning-input-drift \(PoolRuntimeBlue\)/);
    return true;
  });
});

test("mutating the supplied fleet declaration after its first read cannot change or dispatch the frozen operation", async () => {
  const h = harness("PoolRuntimeBlue");
  h.provider.active = async () => {
    Reflect.set(h.manifest.declaration.props, "name", "changed-after-freeze");
    return h.manifest.active;
  };
  await assert.rejects(h.run(), /provisioning-input-drift/);
  assert.equal(h.counts.stage, 0);
  assert.equal(h.counts.create, 0);
});
