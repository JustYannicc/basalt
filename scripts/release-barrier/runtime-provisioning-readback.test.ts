// The fleet bootstrap creates PoolRuntimeBlue or PoolRuntimeGreen with instance_type "basic" and reads it
// back. Cloudflare answers with the resolved preset (vcpu, memory, disk and defaults, no instance_type),
// so the readback is compared by what the create set. Real SDK and fetch client against a local stub.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { containerAttributes } from "./container-observation.ts";
import { decodeCreatedRuntime } from "./provisioning-apply.ts";
import { BarrierRefusal } from "./manifest.ts";
import { provisionRuntime, type RuntimeProvisioningProvider } from "./runtime-provisioning.ts";
import { stateProvisioningStore } from "./provisioning-state.ts";
import { provisioningManifestDigest } from "./provisioning-contract.ts";
import { readForwardJournal, unsettledRuntimeProvisioning } from "./forward-journal.ts";
import { provisioningFixture, resolvedApplication } from "./test/provisioning-fixtures.ts";

const applicationId = "new-application";
const key = "a".repeat(64);
type Configuration = Record<string, unknown>;

async function cloudflare(
  context: TestContext,
  readback: (created: Configuration) => Configuration,
) {
  const calls: string[] = [];
  let created: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    calls.push(request.method!);
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method === "POST")
      created = resolvedApplication(applicationId, "1".repeat(32), JSON.parse(body));
    const result =
      request.method === "GET" && created
        ? {
            ...created,
            configuration: readback(created.configuration as Configuration),
          }
        : created;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ success: true, errors: [], messages: [], result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const run = <A, E>(
    effect: Effect.Effect<A, E, Credentials | import("effect/http/HttpClient").HttpClient>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Retry.none,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(
          Credentials,
          Effect.succeed(
            apiTokenCredentials({
              apiToken: "synthetic",
              apiBaseUrl: `http://127.0.0.1:${address.port}`,
            }),
          ),
        ),
      ),
    );
  return { calls, run };
}

async function bootstrap(
  context: TestContext,
  name: "PoolRuntimeBlue" | "PoolRuntimeGreen",
  readback: (created: Configuration) => Configuration = (configuration) => configuration,
) {
  const f = provisioningFixture(name);
  const { accountId, props } = f.manifest.declaration;
  const wire = await cloudflare(context, (configuration) => current(configuration));
  let current = readback;
  let native: ReturnType<typeof decodeCreatedRuntime> | undefined;
  const provider: RuntimeProvisioningProvider = {
    active: async () => f.manifest.active,
    namespaceBaseline: async () => f.baseline,
    observeNamespace: async () => ({
      accountId: f.baseline.accountId,
      scriptName: f.baseline.scriptName,
      versionId: f.baseline.version.id,
      deploymentId: "deployment",
      namespaces: f.baseline.namespaces,
      containers: f.baseline.containers,
    }),
    applicationAbsent: async () => !wire.calls.includes("POST"),
    // The create alchemy sends, answered as Cloudflare answers it.
    createApplication: async (namespaceId) => {
      native = decodeCreatedRuntime(
        containerAttributes(
          await wire.run(
            Containers.createContainerApplication({
              accountId,
              name: props.name,
              instances: props.instances,
              maxInstances: props.maxInstances,
              schedulingPolicy: props.schedulingPolicy,
              constraints: props.constraints,
              configuration: {
                image: props.image,
                instanceType: props.instanceType,
                environmentVariables: [{ name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId }],
                observability: props.observability,
              },
              durableObjects: { namespaceId },
            }),
          ),
        ),
      );
      return native;
    },
    readApplication: async (id) =>
      decodeCreatedRuntime(
        containerAttributes(
          await wire.run(Containers.getContainerApplication({ accountId, applicationId: id })),
        ),
      ),
    nativeState: async () => ({ application: native!, digest: "1".repeat(64) }),
  };
  const state = await Effect.runPromise(InMemoryService());
  const scope = { name: f.manifest.stack, stage: f.manifest.stage };
  const store = stateProvisioningStore(state, scope, key, (work) => work());
  const head = () =>
    Effect.runPromise(
      unsettledRuntimeProvisioning(scope, key).pipe(
        Effect.provideService(State, Effect.succeed(state)),
      ),
    );
  const forward = () =>
    Effect.runPromise(
      readForwardJournal(scope, key).pipe(Effect.provideService(State, Effect.succeed(state))),
    );
  return {
    f,
    store,
    wire,
    head,
    forward,
    run: () => provisionRuntime(f.manifest, store, provider, f.enable, () => 100),
    serve: (next: (created: Configuration) => Configuration) => {
      current = next;
    },
  };
}

const refusal = (run: () => Promise<unknown>) =>
  run().then(
    () => assert.fail("the bootstrap accepted the readback"),
    (error: unknown) => {
      assert.ok(error instanceof BarrierRefusal, String(error));
      return error;
    },
  );

for (const name of ["PoolRuntimeBlue", "PoolRuntimeGreen"] as const)
  test(`${name}'s bootstrap accepts Cloudflare's resolved readback of the basic application it created`, async (context) => {
    const h = await bootstrap(context, name);
    const receipt = await h.run();
    assert.equal(receipt.resource, name);
    assert.equal(receipt.applicationId, applicationId);
    assert.deepEqual(h.wire.calls, ["POST", "GET"]);
    assert.equal(await h.head(), undefined);
    assert.deepEqual(await h.forward(), { complete: true });
  });

test("fields Cloudflare adds that the create never set do not refuse", async (context) => {
  const h = await bootstrap(context, "PoolRuntimeBlue", (configuration) => ({
    ...configuration,
    labels: [],
    ssh_public_key_ids: [],
  }));
  assert.equal((await h.run()).applicationId, applicationId);
});

test("a set field that reads back different refuses with its paths and JSON types only", async (context) => {
  const h = await bootstrap(context, "PoolRuntimeGreen", (configuration) => ({
    ...configuration,
    vcpu: 0.5,
    environment_variables: [{ name: "UNREVIEWED_SECRET", value: "synthetic-private" }],
    observability: { logs: { enabled: false } },
  }));
  const error = await refusal(h.run);
  assert.equal(error.reason, "provisioning-configuration-drift");
  assert.equal(error.worker, "PoolRuntimeGreen");
  assert.deepEqual(error.delta?.changed, [
    { path: "application.configuration.environmentVariables.0.name", old: "string", new: "string" },
    {
      path: "application.configuration.environmentVariables.0.value",
      old: "string",
      new: "string",
    },
    {
      path: "application.configuration.observability.logs.enabled",
      old: "boolean",
      new: "boolean",
    },
    { path: "application.configuration.vcpu", old: "number", new: "number" },
  ]);
  const { accountId, props } = h.f.manifest.declaration;
  for (const secret of [
    accountId,
    props.image,
    props.name,
    h.f.namespaceId,
    applicationId,
    "synthetic-private",
  ])
    assert.equal(error.message.includes(secret), false, `the refusal exposed ${secret}`);
  assert.match(
    error.message,
    /application\.configuration\.observability\.logs\.enabled boolean -> boolean/,
  );
});

test("a rerun after a refused readback finishes the acknowledged create from its journal", async (context) => {
  const h = await bootstrap(context, "PoolRuntimeBlue", (configuration) => ({
    ...configuration,
    observability: undefined,
  }));
  assert.equal((await refusal(h.run)).reason, "provisioning-configuration-drift");
  // The release's code phase refuses this head; the release resumes the bootstrap it names first.
  const head = await h.head();
  assert.deepEqual(
    { resource: head?.resource, candidate: head?.candidate, manifest: head?.manifest },
    {
      resource: "PoolRuntimeBlue",
      candidate: h.f.manifest.candidate,
      manifest: provisioningManifestDigest(h.f.manifest),
    },
  );
  assert.equal(head?.operations["application-create"]?.outcome, "acknowledged");
  await assert.rejects(h.forward(), /runtime-provisioning-journal-unsettled/);
  h.serve((configuration) => configuration);
  const receipt = await h.run();
  assert.equal(receipt.applicationId, applicationId);
  assert.deepEqual(h.wire.calls, ["POST", "GET", "GET"], "the rerun never created again");
  assert.equal(await h.head(), undefined);
  assert.deepEqual(await h.forward(), { complete: true });
});

test("a rerun after an earlier run left its namespace read pending reads again and finishes", async (context) => {
  const h = await bootstrap(context, "PoolRuntimeBlue");
  // What a release before this fix left behind when State refused the acknowledged baseline write.
  await h.store.write({
    schemaVersion: 2,
    candidate: h.f.manifest.candidate,
    manifest: provisioningManifestDigest(h.f.manifest),
    resource: "PoolRuntimeBlue",
    complete: false,
    operations: {
      "namespace-baseline": { request: h.f.manifest.namespaceBaselineDigest, outcome: "pending" },
    },
  });
  await assert.rejects(h.forward(), /runtime-provisioning-journal-unsettled/);
  assert.equal((await h.head())?.operations["namespace-baseline"]?.outcome, "pending");
  assert.equal((await h.run()).applicationId, applicationId);
  assert.deepEqual(h.wire.calls, ["POST", "GET"]);
  assert.deepEqual(await h.forward(), { complete: true });
});
