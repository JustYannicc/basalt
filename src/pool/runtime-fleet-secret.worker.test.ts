import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

test("the actual controller refuses an absent named secret and observes it without reconstruction", async (context) => {
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  f.secretAvailable(false);
  const before = f.providerReads.length;
  const fields = { operationId: "secret-recovery", configuration: f.configuration };
  assert.equal((await f.command("fleet-configure", fields)).status, 409);
  assert.equal(f.providerReads.length, before);
  assert.deepEqual(await new RuntimeFleetState(f.old.storage, 4).inspect(), []);
  assert.equal(f.instances.size, 0);
  f.secretAvailable(true);
  assert.equal((await f.command("fleet-configure", fields)).status, 200);
  assert.ok(f.providerReads.length > before);
  assert.equal(f.instances.size, 0);
});

test(
  "the actual controller recovers unsent demand and replacement launches after the secret returns",
  { timeout: 10000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    const entered = deferred(),
      release = deferred();
    let response: Promise<Response> | undefined;
    context.after(async () => {
      release.resolve();
      const body = (await response)?.body;
      if (body && !body.locked) await body.cancel();
      await f.cleanup();
    });
    f.onModel(async (_, request) => {
      if (new URL(request.url).searchParams.get("id") !== "held-secret-demand") return undefined;
      entered.resolve();
      await release.promise;
      return new Response("terminal");
    });
    await f.bootstrap();
    const configured = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", {
        operationId: "recover-unsent-enable",
        configuration: { ...f.configuration, targetActive: 1 },
      }),
    );
    f.secretAvailable(false);
    const waiting = f.resourcesWhen((rows) => rows.some((row) => row.phase === "uncertain"));
    response = f.model(new Request("https://pool.invalid/v1/models?id=held-secret-demand"));
    await entered.promise;
    const unsent = (await waiting)[0]!;
    assert.equal(f.instances.size, 0);
    await f.upkeep();
    const state = new RuntimeFleetState(f.old.storage, 4);
    assert.equal((await state.inspect()).length, 1);
    assert.equal((await state.inspect())[0]?.target.slotId, unsent.target.slotId);
    assert.equal(f.instances.size, 0);
    f.secretAvailable(true);
    await f.upkeep();
    const ready = (await state.inspect())[0]!;
    assert.equal(ready.phase, "ready");
    assert.equal(ready.target.slotId, unsent.target.slotId);
    assert.equal(f.instances.get(ready.target.instanceId)?.fixture.calls.start, 1);
    release.resolve();
    assert.equal(await (await response).text(), "terminal");
    await f.settle();
    await f.send("fleet-configure", {
      operationId: "recover-unsent-green",
      configuration: {
        ...f.configuration,
        revision: 2,
        previousDigest: configured.digest,
        active: "green",
        targetActive: 100,
      },
    });
    await f.send("fleet-replace", {
      operationId: "recover-unsent-replace",
      identity: ready.identity,
    });
    f.secretAvailable(false);
    await f.upkeep();
    const replacement = (await state.inspect()).find(
      (row) => row.target.slotId !== ready.target.slotId,
    )!;
    assert.equal(replacement.phase, "uncertain");
    assert.equal(f.instances.size, 1);
    assert.equal(f.instances.get(ready.target.instanceId)?.fixture.calls.destroy, 0);
    f.reconstruct();
    f.secretAvailable(true);
    await f.upkeep();
    const recovered = (await state.inspect()).find(
      (row) => row.target.slotId === replacement.target.slotId,
    )!;
    assert.equal(recovered.phase, "ready");
    assert.equal(f.instances.size, 2);
    assert.equal(f.instances.get(recovered.target.instanceId)?.fixture.calls.start, 1);
    assert.equal(f.instances.get(ready.target.instanceId)?.fixture.calls.start, 1);
  },
);

test(
  "disable fences an unsent recovery while its provider observation is pending",
  { timeout: 10000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    const release = deferred(),
      providerEntered = deferred(),
      providerRelease = deferred();
    let response: Promise<Response> | undefined;
    context.after(async () => {
      release.resolve();
      providerRelease.resolve();
      const body = (await response)?.body;
      if (body && !body.locked) await body.cancel();
      await f.cleanup();
    });
    f.onModel(async (_, request) => {
      if (new URL(request.url).searchParams.get("id") !== "held-disabled-demand") return undefined;
      await release.promise;
      return new Response("terminal");
    });
    await f.bootstrap();
    const permission = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", {
        operationId: "disabled-unsent-enable",
        configuration: { ...f.configuration, targetActive: 1 },
      }),
    );
    f.secretAvailable(false);
    const waiting = f.resourcesWhen((rows) => rows.some((row) => row.phase === "uncertain"));
    response = f.model(new Request("https://pool.invalid/v1/models?id=held-disabled-demand"));
    const unsent = (await waiting)[0]!;
    f.secretAvailable(true);
    f.onProviderRead(async () => {
      providerEntered.resolve();
      await providerRelease.promise;
    });
    const recovery = f.upkeep();
    await providerEntered.promise;
    await f.send("fleet-disable", {
      operationId: "disabled-unsent-stop",
      expectedDigest: permission.digest,
    });
    providerRelease.resolve();
    await recovery;
    assert.equal(
      [...f.instances.values()].reduce((sum, instance) => sum + instance.fixture.calls.start, 0),
      0,
    );
    assert.equal(f.old.calls.start, 0);
    const rows = await new RuntimeFleetState(f.old.storage, 4).inspect();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.target.slotId, unsent.target.slotId);
    assert.equal(rows[0]?.phase, "uncertain");
  },
);
