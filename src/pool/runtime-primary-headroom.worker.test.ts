import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

test(
  "a full fleet reserves primary headroom without destroying held streams or allowing replacement growth to consume it",
  { timeout: 15_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture({ candidateColor: "green" });
    const bodies = new Map<
      string,
      { runtime: string; body: ReadableStreamDefaultController<Uint8Array> }
    >();
    const entered = new Map<number, ReturnType<typeof deferred<void>>>();
    const responses = new Map<string, Promise<Response>>();
    const waitFor = (count: number) => {
      if (bodies.size >= count) return Promise.resolve();
      const event = deferred();
      entered.set(count, event);
      return event.promise;
    };
    context.after(async () => {
      for (const { body } of bodies.values()) {
        try {
          body.close();
        } catch {}
      }
      await Promise.allSettled(
        [...responses.values()].map(async (response) => (await response).body?.cancel()),
      );
      await f.cleanup();
    });
    f.onModel(async (runtime, request) => {
      const id = new URL(request.url).searchParams.get("held");
      if (!id) return undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(body) {
            bodies.set(id, { runtime: runtime.target.instanceId, body });
            body.enqueue(new TextEncoder().encode(`${id}:`));
            entered.get(bodies.size)?.resolve();
          },
        }),
      );
    });
    const dispatch = (id: string) =>
      responses.set(id, f.model(new Request(`https://pool.invalid/v1/models?held=${id}`)));
    await f.bootstrap();
    const first = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", {
        operationId: "grow-four",
        configuration: { ...f.configuration, targetActive: 1 },
      }),
    );
    for (let index = 0; index < 4; index++) dispatch(`root-${index}`);
    await waitFor(4);
    const ready = f.resourcesWhen(
      (rows) => rows.length === 4 && rows.every((row) => row.phase === "ready"),
    );
    now += 101;
    await f.upkeep();
    await ready;
    const configured = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", {
        operationId: "hold-four",
        configuration: {
          ...f.configuration,
          revision: 2,
          previousDigest: first.digest,
          targetActive: 100,
        },
      }),
    );
    for (let index = 0; index < 4; index++) dispatch(`blue-${index}`);
    await waitFor(8);
    const state = new RuntimeFleetState(f.old.storage, 4);
    assert.ok((await state.inspect()).every((row) => row.active === 1));
    const update = {
      operationId: "reserve-primary",
      configurationDigest: configured.digest,
      baseline: structuredClone(f.applications[1]!),
      imageDigest: f.applications[1]!.imageDigest,
      imageInput: f.applications[1]!.imageInput,
    };
    await f.send("image-prepare", { update });
    await f.send("fleet-configure", {
      operationId: "confirm-same-image",
      configuration: {
        ...f.configuration,
        revision: 3,
        previousDigest: configured.digest,
        targetActive: 100,
      },
    });
    const fullGrant = await f.startGrant();
    assert.equal((await f.command("stage", { proof: fullGrant.envelope })).status, 409);
    now += 101;
    await f.upkeep();
    const draining = (await state.inspect()).filter((row) => row.phase === "draining");
    assert.equal(draining.length, 1);
    assert.equal(draining[0]!.active, 1);
    for (const instance of f.instances.values()) assert.equal(instance.fixture.calls.destroy, 0);
    const victim = [...bodies.entries()].find(
      ([, held]) => held.runtime === draining[0]!.target.instanceId,
    )!;
    assert.ok(victim);
    victim[1].body.enqueue(new TextEncoder().encode("terminal"));
    victim[1].body.close();
    bodies.delete(victim[0]);
    assert.equal(await (await responses.get(victim[0])!).text(), `${victim[0]}:terminal`);
    await f.resourcesWhen((rows) =>
      rows.some(
        (row) => row.target.instanceId === draining[0]!.target.instanceId && row.active === 0,
      ),
    );
    now += 1_001;
    await f.upkeep();
    await f.resourcesWhen((rows) => rows.length === 3);
    assert.equal(f.instances.get(draining[0]!.target.instanceId)!.fixture.calls.destroy, 1);
    f.reconstruct();
    await f.upkeep();
    assert.equal((await state.inspect()).length, 3);
    const grant = await f.startGrant();
    assert.equal((await f.command("stage", { proof: grant.envelope })).status, 200);
    assert.equal(await state.physicalCount(), 4);
    for (const row of await state.inspect())
      assert.equal(f.instances.get(row.target.instanceId)!.fixture.calls.destroy, 0);
    assert.equal(f.old.calls.destroy, 0);
  },
);
