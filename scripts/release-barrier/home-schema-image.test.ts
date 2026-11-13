import assert from "node:assert/strict";
import { test } from "node:test";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Effect, Layer } from "effect";
import {
  inspectPoolImage,
  PoolImageMetadataMismatchError,
} from "../deploy-safety/pool-image-metadata.ts";
import { reportRefusal } from "./refusal-report.ts";
import { type ContainerAttributes } from "./container.ts";
import { releaseHomeImage, type HomeImageDependencies } from "./home-schema-image.ts";
import { BarrierRefusal } from "./refusal.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { containerPublication } from "./test/container-fixture.ts";

const scope = { name: "fixture", stage: "production" };
const candidate = "a".repeat(40);
const key = { stack: scope.name, stage: scope.stage, fqn: "PoolContainer" };

async function fixture(before?: (value: ContainerAttributes) => ContainerAttributes) {
  const publication = containerPublication();
  const previous = before ? before(publication.previous) : publication.previous;
  const state = await Effect.runPromise(InMemoryService());
  const native = {
    resourceType: "Cloudflare.Container",
    namespace: undefined,
    fqn: "PoolContainer",
    logicalId: "PoolContainer",
    instanceId: "1".repeat(32),
    providerVersion: 0,
    status: "created" as const,
    downstream: [],
    bindings: [],
    props: {},
    attr: previous,
  };
  await Effect.runPromise(state.set({ ...key, value: native }));
  interface Container extends Resource<"Cloudflare.Container", {}, ContainerAttributes> {}
  const Container = Resource<Container>("Cloudflare.Container");
  const stack = Stack(
    scope.name,
    {
      state: Layer.succeed(State, Effect.succeed(state)),
      providers: Provider.succeed(Container, {
        diff: () => Effect.succeed({ action: "noop" }),
        reconcile: () => Effect.die("Image selection cannot reconcile the container"),
        delete: () => Effect.die("Image selection cannot delete the container"),
      }),
    },
    Container("PoolContainer", {}),
  );
  const plan = await Effect.runPromise(
    evalStack(stack, Plan.make, { stage: scope.stage }).pipe(withReleaseRuntime),
  );
  assert.equal(plan.resources.PoolContainer!.action, "noop");
  const observed: unknown[] = [];
  const inspected: unknown[] = [];
  const io: HomeImageDependencies = {
    token: Effect.succeed("synthetic-token"),
    observe: (target) => {
      observed.push(target);
      return Effect.succeed(structuredClone(previous));
    },
    inspect: async (image, digest, credentials) => {
      inspected.push({ image, digest, credentials });
      return { ...publication.metadata, digest };
    },
  };
  const run = (changes = [] as readonly (typeof publication.frozen)[]) =>
    Effect.runPromise(releaseHomeImage(scope, candidate, plan, state, changes, io));
  return { publication, previous, native, state, plan, io, observed, inspected, run };
}

test("Worker-only release selects the noop container from registered State and verifies live immutable image metadata", async () => {
  const setup = await fixture();
  const result = await setup.run();
  const digest = setup.previous.hash!.digest!;
  assert.deepEqual(result, {
    image: {
      image: setup.previous.configuration.image,
      imageDigest: digest,
      imageConfigDigest: setup.publication.metadata.configDigest,
    },
    credentials: { accountId: "fixture", apiToken: "synthetic-token" },
    identity: {
      candidate,
      imageDigest: digest,
      imageConfigDigest: setup.publication.metadata.configDigest,
      baselineImageDigest: digest,
      sourceInputHash: setup.previous.hash!.image!,
      baselineInputHash: setup.previous.hash!.image!,
    },
  });
  assert.equal(setup.observed.length, 1);
  assert.deepEqual(setup.inspected, [
    {
      image: setup.previous.configuration.image,
      digest,
      credentials: { accountId: "fixture", apiToken: "synthetic-token" },
    },
  ]);
  assert.deepEqual(await Effect.runPromise(setup.state.get(key)), setup.native);
});

test("changed container retains the exact admitted image, config digest, source and baseline identities", async () => {
  const setup = await fixture();
  await Effect.runPromise(setup.state.delete(key));
  const frozen = setup.publication.frozen;
  const result = await setup.run([frozen]);
  assert.deepEqual(result, {
    image: {
      image: frozen.configuration.image,
      imageDigest: frozen.imageDigest,
      imageConfigDigest: frozen.imageConfigDigest,
    },
    credentials: { accountId: frozen.baseline.accountId, apiToken: "synthetic-token" },
    identity: {
      candidate,
      imageDigest: frozen.imageDigest,
      imageConfigDigest: frozen.imageConfigDigest,
      baselineImageDigest: setup.previous.hash!.digest!,
      sourceInputHash: frozen.inputHash,
      baselineInputHash: frozen.baselineInputHash,
    },
  });
  assert.deepEqual(setup.observed, []);
  assert.deepEqual(setup.inspected, []);
});

for (const mode of ["missing", "wrong-type", "changed"] as const)
  test(`Worker-only fallback refuses a ${mode} candidate plan`, async () => {
    const setup = await fixture();
    const node = setup.plan.resources.PoolContainer!;
    const plan: Plan.Plan = {
      ...setup.plan,
      resources:
        mode === "missing"
          ? {}
          : {
              PoolContainer:
                mode === "wrong-type"
                  ? { ...node, resource: { ...node.resource, Type: "Cloudflare.Worker" } }
                  : { ...node, action: "create", props: {}, state: undefined },
            },
    };
    await assert.rejects(
      Effect.runPromise(releaseHomeImage(scope, candidate, plan, setup.state, [], setup.io)),
      /home-schema-candidate-image-unavailable/,
    );
    assert.deepEqual(setup.observed, []);
    assert.deepEqual(setup.inspected, []);
  });

for (const mode of [
  "missing",
  "wrong-type",
  "wrong-fqn",
  "wrong-id",
  "updating",
  "malformed",
] as const)
  test(`Worker-only fallback refuses ${mode} registered State`, async () => {
    const setup = await fixture();
    if (mode === "missing") await Effect.runPromise(setup.state.delete(key));
    else if (mode === "updating")
      await Effect.runPromise(
        setup.state.set({
          ...key,
          value: {
            ...setup.native,
            status: "updating",
            old: {
              props: setup.native.props,
              bindings: setup.native.bindings,
              attr: setup.native.attr,
            },
          },
        }),
      );
    else
      await Effect.runPromise(
        setup.state.set({
          ...key,
          value: {
            ...setup.native,
            ...(mode === "wrong-type" ? { resourceType: "Cloudflare.Worker" } : {}),
            ...(mode === "wrong-fqn" ? { fqn: "OtherContainer" } : {}),
            ...(mode === "wrong-id" ? { logicalId: "OtherContainer" } : {}),
            ...(mode === "malformed" ? { attr: {} } : {}),
          },
        }),
      );
    await assert.rejects(setup.run(), /home-schema-candidate-image-unavailable/);
    assert.deepEqual(setup.observed, []);
    assert.deepEqual(setup.inspected, []);
  });

for (const mode of ["instance", "source", "digest", "image", "version", "configuration"] as const)
  test(`registered ${mode} drift after the noop plan refuses before live inspection`, async () => {
    const setup = await fixture();
    const previous = setup.previous;
    await Effect.runPromise(
      setup.state.set({
        ...key,
        value: {
          ...setup.native,
          instanceId: mode === "instance" ? "9".repeat(32) : setup.native.instanceId,
          attr: {
            ...previous,
            version: mode === "version" ? previous.version + 1 : previous.version,
            hash: {
              ...previous.hash,
              image: mode === "source" ? "c".repeat(16) : previous.hash!.image,
              digest: mode === "digest" ? `sha256:${"c".repeat(64)}` : previous.hash!.digest,
            },
            configuration: {
              ...previous.configuration,
              ...(mode === "image"
                ? { image: setup.publication.proposed.configuration.image }
                : {}),
              ...(mode === "configuration" ? { command: ["other"] } : {}),
            },
          },
        },
      }),
    );
    await assert.rejects(setup.run(), /home-schema-baseline-image-drift/);
    assert.deepEqual(setup.observed, []);
    assert.deepEqual(setup.inspected, []);
  });

for (const mode of [
  "account",
  "application",
  "version",
  "rollout",
  "image",
  "configuration",
] as const)
  test(`live ${mode} drift refuses before metadata inspection`, async () => {
    const setup = await fixture();
    setup.io.observe = () =>
      Effect.succeed({
        ...setup.previous,
        ...(mode === "account" ? { accountId: "other" } : {}),
        ...(mode === "application" ? { applicationId: "other" } : {}),
        ...(mode === "version" ? { version: setup.previous.version + 1 } : {}),
        ...(mode === "rollout" ? { activeRolloutId: "unsettled" } : {}),
        configuration: {
          ...setup.previous.configuration,
          ...(mode === "image" ? { image: setup.publication.proposed.configuration.image } : {}),
          ...(mode === "configuration" ? { command: ["other"] } : {}),
        },
      });
    await assert.rejects(setup.run(), /home-schema-baseline-image-drift/);
    assert.deepEqual(setup.inspected, []);
  });

test("read and metadata failures refuse without exposing provider diagnostics", async () => {
  const unavailable = await fixture();
  unavailable.io.observe = () => Effect.fail(new BarrierRefusal("container-observation-failed"));
  await assert.rejects(unavailable.run(), /container-observation-failed/);
  assert.deepEqual(unavailable.inspected, []);
  const failed = await fixture();
  failed.io.inspect = async () => {
    throw new Error("synthetic-private-provider-detail");
  };
  await assert.rejects(failed.run(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /home-schema-image-admission-failed/);
    assert.doesNotMatch(error.message, /synthetic-private-provider-detail/);
    return true;
  });
});

test("Worker-only metadata identity failures keep known facts in the release job output", async () => {
  for (const [property, expected, observed] of [
    ["platform", "linux/amd64", "linux/arm64"],
    ["digest", `sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`],
    ["configDigest", `sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`],
  ] as const) {
    const setup = await fixture();
    setup.io.inspect = async () => {
      throw new PoolImageMetadataMismatchError(property, expected, observed);
    };
    const failure = await Effect.runPromise(
      releaseHomeImage(scope, candidate, setup.plan, setup.state, [], setup.io).pipe(Effect.flip),
    );
    assert.ok(failure instanceof BarrierRefusal);
    const lines: string[] = [];
    await reportRefusal(failure, undefined, (line) => lines.push(line));
    assert.ok(lines.join("\n").includes(`image.${property}`));
    assert.ok(lines.join("\n").includes(expected));
    assert.ok(lines.join("\n").includes(observed));
  }
});

test("mutable, mismatched and foreign-account image references cannot establish readiness", async () => {
  const mutable = await fixture((previous) => ({
    ...previous,
    configuration: {
      ...previous.configuration,
      image: "registry.cloudflare.com/fixture/pool:latest",
    },
  }));
  await assert.rejects(mutable.run(), /container-image-is-not-immutable/);
  const mismatch = await fixture((previous) => {
    assert.ok(previous.hash);
    return {
      ...previous,
      hash: { ...previous.hash, digest: `sha256:${"9".repeat(64)}` },
    };
  });
  await assert.rejects(mismatch.run(), /home-schema-baseline-image-drift/);
  const foreign = await fixture((previous) => ({
    ...previous,
    configuration: {
      ...previous.configuration,
      image: previous.configuration.image.replace("/fixture/", "/other/"),
    },
  }));
  let requests = 0;
  foreign.io.inspect = (image, digest, credentials) =>
    inspectPoolImage(image, digest, credentials, async () => {
      requests++;
      throw new Error("No network request is authorized");
    });
  await assert.rejects(foreign.run(), /home-schema-image-admission-failed/);
  assert.equal(requests, 0);
  assert.deepEqual(mutable.inspected, []);
  assert.deepEqual(mismatch.inspected, []);
});
