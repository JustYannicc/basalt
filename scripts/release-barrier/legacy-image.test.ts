import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { stageContainer, describeContainer } from "./container.ts";
import { containerProps, containerPublication } from "./test/container-fixture.ts";
import { readFrozenContainers } from "./recovery-manifest.ts";

function fixture() {
  const f = containerPublication();
  const { context: _context, ...policy } = containerProps();
  const props = { ...policy, image: f.previous.configuration.image };
  const publication = {
    ...f.publication,
    proposed: {
      ...f.proposed,
      configuration: structuredClone(f.previous.configuration),
      hash: { ...f.proposed.hash, digest: f.previous.hash!.digest },
    },
    rolloutRequest: {
      ...f.publication.rolloutRequest,
      targetConfiguration: structuredClone(f.previous.configuration),
    },
  };
  return {
    ...f,
    props,
    publication,
    metadata: { ...f.metadata, digest: f.previous.hash!.digest! },
  };
}

test("an immutable legacy pin preserves runtime input provenance and records the separate reference hash", async () => {
  const f = fixture(),
    events: string[] = [];
  const publication = {
    ...f.publication,
    verifySource: Effect.sync(() => {
      events.push("source");
    }),
  };
  const staged = stageContainer(publication, f.props, containerProps(), f.previous, (value) => {
    events.push("provider-and-image");
    assert.equal(value.proposed.configuration.image, f.previous.configuration.image);
    return Effect.succeed(f.metadata);
  });
  const result = await Effect.runPromise(staged);
  assert.equal(result.frozen.inputHash, f.previous.hash!.image);
  assert.equal(result.frozen.preservedSourceInputHash, f.proposed.hash.image);
  assert.equal(result.publication.proposed.hash!.image, f.previous.hash!.image);
  assert.equal(publication.proposed.hash.image, f.proposed.hash.image);
  assert.deepEqual(await Effect.runPromise(staged), result);
  assert.deepEqual(events, ["source", "provider-and-image", "source", "provider-and-image"]);
  assert.equal(describeContainer(result.frozen).preservedSourceInputHash, f.proposed.hash.image);
  const recovered = readFrozenContainers({
    schemaVersion: 2,
    candidate: "a".repeat(40),
    stack: "synthetic",
    stage: "production",
    containers: [result.frozen],
    workers: [],
  });
  assert.deepEqual(recovered.containers, [result.frozen]);
});

test("a legacy pin cannot conceal image, configuration, namespace, placement or resource changes", async () => {
  for (const kind of ["image", "configuration", "namespace", "placement", "resources"] as const) {
    const f = fixture();
    if (kind === "image") f.props.image = f.proposed.configuration.image;
    if (kind === "configuration") f.publication.proposed.configuration.instanceType = "standard-1";
    if (kind === "namespace") f.publication.proposed.durableObjects = { namespaceId: "other" };
    if (kind === "placement") f.props.constraints = { jurisdiction: "eu", regions: ["EEUR"] };
    if (kind === "resources") f.props.maxInstances = 2;
    let inspected = 0;
    await assert.rejects(
      Effect.runPromise(
        stageContainer(f.publication, f.props, containerProps(), f.previous, () => {
          inspected++;
          return Effect.succeed(f.metadata);
        }),
      ),
    );
    assert.equal(inspected, 0);
  }
});

test("an existing single-runtime application retains its image and native input without gaining image-update authority", async () => {
  const f = fixture();
  const olds = { ...containerProps(), className: "PoolRuntime", instances: 0 };
  const props = { ...f.props, className: "PoolRuntime", instances: 0 };
  const previous = { ...f.previous, instances: 0 };
  const publication = {
    ...f.publication,
    id: "PoolRuntime",
    previous,
    proposed: { ...f.publication.proposed, instances: 0 },
  };
  const staged = await Effect.runPromise(
    stageContainer(publication, props, olds, previous, () => Effect.succeed(f.metadata)),
  );
  assert.equal(staged.frozen.inputHash, previous.hash!.image);
  assert.equal(staged.frozen.configuration.image, previous.configuration.image);
  for (const changed of [
    { ...props, image: f.proposed.configuration.image },
    { ...props, maxInstances: 4 },
    { ...props, instances: 1 },
  ]) {
    let reads = 0;
    await assert.rejects(
      Effect.runPromise(
        stageContainer(publication, changed, olds, previous, () => {
          reads++;
          return Effect.succeed(f.metadata);
        }),
      ),
    );
    assert.equal(reads, 0);
  }
});
