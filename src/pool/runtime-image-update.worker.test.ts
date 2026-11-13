import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";

const phase = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ phase: Schema.String }))(value).phase;

test("the signed release freeze refuses an active image and releases only after the exact inactive publication is observed", async (context) => {
  const f = await fleetWorkerFixture({ candidateColor: "green" });
  context.after(() => f.cleanup());
  await f.bootstrap();
  const record = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
    await f.send("fleet-configure", { operationId: "enable", configuration: f.configuration }),
  );
  const update = {
    operationId: "publish-green-v2",
    configurationDigest: record.digest,
    baseline: structuredClone(f.applications[1]!),
    imageDigest: `sha256:${"9".repeat(64)}`,
    imageInput: "8".repeat(16),
  };
  assert.equal(
    (await f.command("image-prepare", { update: { ...update, baseline: f.applications[0]! } }))
      .status,
    409,
  );
  assert.equal(phase(await f.send("image-prepare", { update })), "prepared");
  f.reconstruct();
  assert.equal(
    phase(await f.send("image-inspect", { operationId: update.operationId })),
    "prepared",
  );
  const grant = await f.startGrant();
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 409);
  assert.equal(f.instances.size, 0);
  assert.equal(
    (await f.command("image-prepare", { update: { ...update, imageInput: "7".repeat(16) } }))
      .status,
    409,
  );
  const serving = await f.model();
  assert.equal(serving.status, 200);
  assert.ok(
    Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))(
      await serving.json(),
    ).data.length > 0,
  );
  assert.equal(
    (
      await f.command("fleet-configure", {
        operationId: "pretend-published",
        configuration: {
          ...f.configuration,
          revision: 2,
          previousDigest: record.digest,
        },
      })
    ).status,
    409,
  );
  await f.publishApplication("green", 2, update.imageDigest, update.imageInput);
  assert.equal((await f.command("image-cancel", { operationId: update.operationId })).status, 409);
  await f.send("fleet-configure", {
    operationId: "accept-green-v2",
    configuration: {
      ...f.configuration,
      revision: 2,
      previousDigest: record.digest,
    },
  });
  assert.equal(
    phase(await f.send("image-inspect", { operationId: update.operationId })),
    "completed",
  );
  assert.equal((await f.view()).response.status, 200);
});

test("unknown provider state keeps the freeze across reconstruction and cancellation needs unchanged empty provider state", async (context) => {
  const f = await fleetWorkerFixture({ candidateColor: "green" });
  context.after(() => f.cleanup());
  await f.bootstrap();
  const record = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
    await f.send("fleet-configure", { operationId: "enable", configuration: f.configuration }),
  );
  const update = {
    operationId: "unknown-publish",
    configurationDigest: record.digest,
    baseline: structuredClone(f.applications[1]!),
    imageDigest: `sha256:${"9".repeat(64)}`,
    imageInput: "8".repeat(16),
  };
  f.providerAvailable(false);
  assert.equal((await f.command("image-prepare", { update })).status, 409);
  f.reconstruct();
  assert.equal(
    phase(await f.send("image-inspect", { operationId: update.operationId })),
    "checking",
  );
  assert.equal((await f.command("image-cancel", { operationId: update.operationId })).status, 409);
  const grant = await f.startGrant();
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 409);
  assert.equal(f.instances.size, 0);
  f.providerAvailable(true);
  assert.equal(
    phase(await f.send("image-cancel", { operationId: update.operationId })),
    "cancelled",
  );
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 200);
});

for (const changedImage of [false, true])
  test(`an unchanged provider version admits only unchanged image bytes and settings (changed=${changedImage})`, async (context) => {
    const f = await fleetWorkerFixture({ candidateColor: "green" });
    context.after(() => f.cleanup());
    await f.bootstrap();
    const configured = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", { operationId: "enable", configuration: f.configuration }),
    );
    const baseline = structuredClone(f.applications[1]!);
    const update = {
      operationId: "same-provider-version",
      configurationDigest: configured.digest,
      baseline,
      imageDigest: changedImage ? `sha256:${"9".repeat(64)}` : baseline.imageDigest,
      imageInput: "8".repeat(16),
    };
    assert.equal(phase(await f.send("image-prepare", { update })), "prepared");
    await f.publishApplication(
      "green",
      Number(baseline.applicationVersion),
      update.imageDigest,
      update.imageInput,
    );
    const accepted = await f.command("fleet-configure", {
      operationId: "accept-same-version",
      configuration: {
        ...f.configuration,
        revision: 2,
        previousDigest: configured.digest,
      },
    });
    assert.equal(accepted.status, changedImage ? 409 : 200);
    assert.equal(
      phase(await f.send("image-inspect", { operationId: update.operationId })),
      changedImage ? "prepared" : "completed",
    );
    assert.equal((await f.model()).status, 200);
  });
