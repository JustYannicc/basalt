import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { StartAuthorization } from "./runtime-slots/admission-proof.ts";
import { SlotIdentity } from "./runtime-slots/contract.ts";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { joinedRuntimeProof } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { brand } from "../../brand.ts";

test("a primary version promotion keeps fleet permission, Home authority and the old response body", async (context) => {
  const f = await fleetWorkerFixture({ publicProbe: true });
  let held: ReadableStreamDefaultController<Uint8Array> | undefined;
  context.after(async () => {
    try {
      held?.close();
    } catch {}
    await f.cleanup();
  });
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "enable-version-test",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  f.onModel(async (runtime, request) => {
    if (new URL(request.url).searchParams.has("held"))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            held = controller;
            controller.enqueue(new TextEncoder().encode("old:"));
          },
        }),
      );
    return new Response(
      request.headers.get("authorization")?.startsWith(`Bearer ${brand.setup.keyPrefix}`)
        ? JSON.stringify({ data: [{ id: "synthetic-model" }] })
        : runtime.target.applicationId,
    );
  });
  const old = await f.model(new Request("https://pool.invalid/v1/models?held=1"));
  const originalBoot = old.headers.get("X-Signalbox-Pool-Boot");
  const reading = old.text();
  const grant = await f.startGrant();
  const staged = await f.command("stage", { proof: grant.envelope });
  assert.equal(staged.status, 200, await staged.clone().text());
  const identity = Schema.decodeUnknownSync(Schema.Struct({ result: SlotIdentity }))(
    await staged.json(),
  ).result;
  const runtime = f.instances.get(identity.instanceId)!.fixture;
  const joined = await joinedRuntimeProof(
    runtime,
    f.old.storage,
    Schema.decodeUnknownSync(StartAuthorization)(grant.proof),
  );
  await f.send("candidate-probe", { operationId: "probe-blue", pool: f.claims.pool });
  const promoted = await f.command("promote", { intent: await f.intent(), proof: joined.envelope });
  assert.equal(promoted.status, 200, await promoted.clone().text());
  const next = await f.model();
  assert.equal(next.status, 200);
  assert.equal(await next.text(), f.applications[0]!.applicationId);
  assert.notEqual(next.headers.get("X-Signalbox-Pool-Boot"), originalBoot);
  assert.equal((await f.view()).response.status, 200);
  const permission = Schema.decodeUnknownSync(
    Schema.Struct({
      permission: Schema.Struct({
        enabled: Schema.Boolean,
        configuration: Schema.Struct({ legacy: SlotIdentity }),
      }),
    }),
  )(await f.send("fleet-inspect"));
  assert.equal(permission.permission.enabled, true);
  assert.deepEqual(permission.permission.configuration.legacy, identity);
  assert.equal(f.old.calls.destroy, 0);
  held!.enqueue(new TextEncoder().encode("terminal"));
  held!.close();
  held = undefined;
  assert.equal(await reading, "old:terminal");
});

test(
  "primary promotion stops new reservations on the old generation while held fleet streams survive reconstruction",
  { timeout: 10_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture({ candidateColor: "green", publicProbe: true });
    const pending = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const arrivals = new Map<number, ReturnType<typeof deferred<void>>>();
    const requests: Promise<Response>[] = [];
    const waitFor = (count: number) => {
      if (pending.size >= count) return Promise.resolve();
      const event = deferred();
      arrivals.set(count, event);
      return event.promise;
    };
    context.after(async () => {
      for (const body of pending.values()) {
        try {
          body.close();
        } catch {}
      }
      await Promise.allSettled(requests);
      await f.cleanup();
    });
    f.onModel(async (runtime, request) => {
      const id = new URL(request.url).searchParams.get("held");
      if (!id)
        return new Response(
          request.headers.get("authorization")?.startsWith(`Bearer ${brand.setup.keyPrefix}`)
            ? JSON.stringify({ data: [{ id: "synthetic-model" }] })
            : runtime.target.applicationId,
        );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            pending.set(id, controller);
            controller.enqueue(new TextEncoder().encode(`${id}:`));
            arrivals.get(pending.size)?.resolve();
          },
        }),
      );
    });
    const dispatch = (id: string) =>
      requests.push(f.model(new Request(`https://pool.invalid/v1/models?held=${id}`)));
    await f.bootstrap();
    const enabled = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", { operationId: "grow-old", configuration: f.configuration }),
    );
    for (let index = 0; index < 4; index++) dispatch(`root-${index}`);
    await waitFor(4);
    const ready = f.resourcesWhen(
      (rows) => rows.length === 2 && rows.every((row) => row.phase === "ready"),
    );
    now += 101;
    await f.upkeep();
    await ready;
    await f.send("fleet-configure", {
      operationId: "hold-old",
      configuration: {
        ...f.configuration,
        revision: 2,
        previousDigest: enabled.digest,
        targetActive: 100,
      },
    });
    dispatch("blue-0");
    dispatch("blue-1");
    await waitFor(6);
    const state = new RuntimeFleetState(f.old.storage, 4);
    const oldRows = await state.inspect();
    assert.ok(oldRows.every((row) => row.active === 1));
    const grant = await f.startGrant();
    const staged = Schema.decodeUnknownSync(SlotIdentity)(
      await f.send("stage", { proof: grant.envelope }),
    );
    const runtime = f.instances.get(staged.instanceId)!.fixture;
    const joined = await joinedRuntimeProof(
      runtime,
      f.old.storage,
      Schema.decodeUnknownSync(StartAuthorization)(grant.proof),
    );
    await f.send("candidate-probe", { operationId: "probe-green", pool: f.claims.pool });
    await f.send("promote", { intent: await f.intent(), proof: joined.envelope });
    assert.ok((await state.inspect()).every((row) => row.phase === "draining" && row.active === 1));
    for (const row of oldRows)
      assert.equal(f.instances.get(row.target.instanceId)!.fixture.calls.destroy, 0);
    f.reconstruct();
    for (let index = 0; index < 6; index++) {
      const response = await f.model();
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "green-application");
    }
    assert.equal((await f.view()).response.status, 200);
    for (const [id, body] of pending) {
      body.enqueue(new TextEncoder().encode("terminal"));
      body.close();
      assert.equal(
        await (await requests[[...pending.keys()].indexOf(id)]!).text(),
        `${id}:terminal`,
      );
    }
    pending.clear();
    await f.settle();
    await f.resourcesWhen((rows) => rows.every((row) => row.active === 0));
    now += 1_001;
    await f.upkeep();
    assert.equal((await state.inspect()).length, 0);
    for (const row of oldRows)
      assert.equal(f.instances.get(row.target.instanceId)!.fixture.calls.destroy, 1);
    assert.equal(
      f.old.calls.model +
        [...f.instances.values()].reduce((sum, instance) => sum + instance.fixture.calls.model, 0),
      13,
    );
    assert.equal(f.probeKeys.keys.length, 0);
  },
);
