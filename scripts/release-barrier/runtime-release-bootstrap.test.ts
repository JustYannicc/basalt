import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { RuntimeImageReleasePlan } from "../../src/pool/image-release-plan.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { provisioningDeclarations } from "./provisioning-stack.ts";
import { runtimeReleaseState } from "./runtime-release-state.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { bootstrapImagePlan } from "./runtime-release-plan.ts";
import { bootstrapDeclaration } from "./runtime-release-bootstrap.ts";
import { readRuntimeExports } from "./provisioning-exports.ts";
import { decodeProvisioningInput } from "./provisioning-refusal.ts";
import { BarrierRefusal } from "./refusal.ts";
import { containerPublication } from "./test/container-fixture.ts";
import { nativeReleaseRows } from "./test/native-release-rows.ts";

const accountId = "1".repeat(32);
const candidate = "a".repeat(40);
// Alchemy publishes `<repository>@<digest>` and the release reads it back from the native row.
const rootImage = `registry.cloudflare.com/${accountId}/poolcontainer@sha256:${"4".repeat(64)}`;
const legacyImage = `registry.cloudflare.com/${accountId}/basalt-production-pool-runtime@sha256:${"5".repeat(64)}`;
const blueImage = `registry.cloudflare.com/${accountId}/basalt-production-pool-runtime-blue@sha256:${"6".repeat(64)}`;
// The props the PoolRuntime declaration stored when it was created from an immutable image.
const legacyProps = {
  isExternal: true,
  name: "basalt-production-pool-runtime",
  className: "PoolRuntime",
  image: legacyImage,
  instanceType: "basic",
  instances: 0,
  maxInstances: 1,
  schedulingPolicy: "default",
  constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
  observability: { logs: { enabled: true } },
};

async function nativeRelease(withBlue: boolean) {
  const { state, put } = await nativeReleaseRows(
    { name: "basalt", stage: "production" },
    accountId,
    "b".repeat(64),
  );
  const containers = [
    ["PoolContainer", rootImage, { className: "PoolContainer" }],
    ["PoolRuntime", legacyImage, legacyProps],
    ["PoolRuntimeBlue", blueImage, {}],
  ] as const;
  for (const [index, [resource, image, props]] of containers
    .filter(([resource]) => withBlue || resource !== "PoolRuntimeBlue")
    .entries()) {
    const base = containerPublication().previous;
    await put(resource, "Cloudflare.Container", props, {
      ...base,
      accountId,
      applicationId: `native-${resource}`,
      version: index + 1,
      configuration: { ...base.configuration, image },
      durableObjects: { namespaceId: `native-namespace-${resource}` },
      hash: { image: String(index + 7).repeat(16), digest: image.split("@")[1] },
    });
  }
  const baseline = await Effect.runPromise(
    runtimeReleaseState({ name: "basalt", stage: "production" }).pipe(
      Effect.provideService(State, Effect.succeed(state)),
    ),
  );
  const record: RuntimeReleaseRecord = {
    format: "pool-image-release-v1",
    candidate,
    complete: false,
    baseline,
    desiredInput: "8".repeat(16),
    desiredConfiguration: baseline.configuration,
    bootstrap: {},
    configurations: {},
  };
  return record;
}

const compile = (record: RuntimeReleaseRecord, color: "blue" | "green") =>
  Effect.runPromise(
    evalStack(
      Stack(
        "basalt",
        {
          providers: Layer.empty,
          state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
        },
        provisioningDeclarations,
      ),
      Effect.succeed,
      { stage: "production" },
    ).pipe(
      Effect.provideService(RuntimeImageReleasePlan, bootstrapImagePlan(record, color)),
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      withReleaseRuntime,
    ),
  );

test("the first blue/green bootstrap declares each color the reviewed create schema accepts", async () => {
  for (const [color, name, withBlue] of [
    ["blue", "PoolRuntimeBlue", false],
    ["green", "PoolRuntimeGreen", true],
  ] as const) {
    const record = await nativeRelease(withBlue);
    const stack = await compile(record, color);
    const resource = stack.resources[name];
    assert.ok(resource, name);
    const declaration = await Effect.runPromise(
      bootstrapDeclaration({
        name,
        props: resource.Props,
        candidate,
        root: record.baseline.applications.root,
        // inspectPoolImage only returns after proving these exact platform and label values.
        metadata: {
          digest: rootImage.split("@")[1]!,
          configDigest: `sha256:${"c".repeat(64)}`,
          platform: "linux/amd64",
          capabilityLabel: "1",
        },
      }),
    );
    assert.equal(declaration.fqn, name);
    assert.equal(declaration.props.image, rootImage);
    assert.equal(declaration.props.maxInstances, 4);
    assert.equal(declaration.accountId, accountId);
  }
});

const refusedPaths = (decode: () => unknown) => {
  try {
    decode();
  } catch (error) {
    assert.ok(error instanceof BarrierRefusal);
    assert.equal(error.reason, "runtime-private-input-invalid");
    return error.delta?.changed.map((change) => change.path);
  }
  assert.fail("expected a refusal");
};

test("private input refusals name the decoder, so a Worker version without declarative exports is diagnosable", () => {
  // A Worker uploaded with Durable Object migrations reads back without an `exports` key.
  for (const exports of [undefined, null])
    assert.deepEqual(
      refusedPaths(() => readRuntimeExports(exports)),
      ["namespace.exports"],
    );
  assert.deepEqual(
    refusedPaths(() => readRuntimeExports({ Old: { type: "durable-object", state: "deleted" } })),
    ["namespace.exports.Old.storage", "namespace.exports.Old.state"],
  );
  // A private location's later segments and its issue keys stay redacted.
  assert.deepEqual(
    refusedPaths(() =>
      decodeProvisioningInput(
        Schema.Struct({ material: Schema.String }),
        "observationToken.created",
      )({ material: 1 }),
    ),
    ["observationToken.[changed].[changed]"],
  );
  for (const location of ["worker.env", "bindings.secret", "a-b"])
    assert.throws(
      () => decodeProvisioningInput(Schema.String, location),
      /is not a plain constant/,
    );
});
